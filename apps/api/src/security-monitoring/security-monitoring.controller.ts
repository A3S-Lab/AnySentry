import { BadRequestException, Body, ConflictException, Controller, Get, Header, Headers, HttpCode, NotFoundException, OnModuleDestroy, Optional, Param, PayloadTooLargeException, Post, Put, Query, ServiceUnavailableException, Sse, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Observable, exhaustMap, map, mergeMap, timer } from 'rxjs';
import { SkipWrap } from '../shared/api-response.interceptor';
import { AgentMetadataService } from './agent-metadata.service';
import { AgentRuntimeStateService } from './agent-runtime-state.service';
import { currentAgentSubjectAssetIds, mergePersistentAgentDirectory } from './agent-directory';
import {
  enrichAgentConversationDirectoryV2,
  projectAgentConversationDirectory,
} from './agent-conversation-directory';
import { AggregationService } from './aggregation.service';
import { AlertingService } from './alerting.service';
import { AuditService } from './audit.service';
import {
  authorizeCorrelationClaims,
  IngestionSourceResolution,
  IngestionSourceService,
} from './ingestion-source.service';
import { IdentityReviewAgentService } from './identity-review-agent.service';
import { testDeepInvestigationConnection, testFastReviewConnection } from './judgment-connectivity';
import { KubeIdentityService } from './kube-identity.service';
import { managementAuthConfigured, ManagementAuthGuard, RequireManagementAuth } from './management-auth.guard';
import { RelationalBusinessStore } from './relational-business-store.service';
import { MaintenanceWindowService } from './maintenance-window.service';
import { NotificationService } from './notification.service';
import { ObjectiveService } from './objective.service';
import { PolicyConfigError, sanitizePolicy } from './policy-config';
import { normalizePipelineAccounting } from './pipeline-accounting';
import { parseCollectorCaptureProfileMetrics } from './collector-capture-profile';
import { correlationCaptureRollout } from './correlation-rollout';
import {
  parseProcessLifecycleSource,
  parseUnknownReason,
  processContextWithoutLifecycle,
  visibleProcessContext,
} from './classification-semantics';
import { RemediationService } from './remediation.service';
import { SecurityAssistantService } from './security-assistant.service';
import { PreparedJudgeAcceptOutcome, SentryJudgeService } from './sentry-judge.service';
import { StreamingFindingService } from './streaming-finding.service';
import { RuntimeModelConfigService, RuntimeModelProfile, sanitizeRuntimeModelConnection } from './runtime-model-config';
import { StreamingQueueService } from './streaming-queue.service';
import { SupplyChainService } from './supply-chain.service';
import { UserDirectoryService } from './user-directory.service';
import { WorkspaceDirectoryService } from './workspace-directory.service';
import { PlatformMetricsService } from './platform-metrics.service';
import { SystemContextService, type SystemContextQuery } from './system-context.service';
import { UnknownLearningRuntimeService } from './unknown-learning-runtime.service';
import type { UnknownLearnedAction, UnknownPolicyStage } from './unknown-learning';
import { InfrastructureRuleError, InfrastructureRuleService } from './infrastructure-rule.service';
import { ObservedAssetLifecycleService } from './observed-asset-lifecycle.read.service';
import { parseObserverAgentInteraction } from './agent-interaction';
import { OBSERVER_LEGACY_SOURCE_PAYLOAD_SHA256_ATTRIBUTE } from './clickhouse-store';
import { captureClassificationDecision } from './identity-judgment-routing';
import { AgentConversationBindingService } from './agent-conversation-binding.service';
import { CanonicalObservabilityService } from './canonical-observability.service';
import { CANONICAL_SESSION_ID_ALGORITHM_V1, SESSION_KEY_ALGORITHM_V1, SESSION_HASH_SECRET_MODE, canonicalParentSessionIdForMembership, canonicalSessionIdForMembership, createEvidenceLink, deriveAgentInstanceIdentity, deriveProcessGenerationKey, resolveSessionIdentity, validateKernelFact } from './canonical-observability';
import { agentRuntimeInstanceIdForEvent } from './agent-identity';
import type { EvidenceLink, KernelFact, SemanticRecord } from './canonical-observability';
import { canonicalEvidenceLinksForRelations as buildCanonicalEvidenceLinks } from './agent-semantic-kernel-relation';
import type { UnknownInfrastructureDraftRequest } from './infrastructure-rule.types';
import {
  bindServerTrustedCorrelationContext,
  serverTrustedCorrelationContext,
  type ServerSourceTrustContext,
  type TrustedCorrelationBindingScope,
  type TrustedCorrelationClaimRejectionReason,
  type TrustedCorrelationInput,
} from './trusted-correlation';
import {
  ClaimScanTaskRequest,
  RegisterWorkspaceRequest,
  ScanTaskHeartbeatRequest,
  SubmitScanResultRequest,
} from './supply-chain.types';
import * as T from './types';

/** Ingest a real observer event: judge it via sentry and record it for the dashboard. */
interface IngestBody extends Partial<T.EventMeta> {
  line: string; // a raw a3s-observer NDJSON line (identity + event) — metadata is derived from it
  collectorId?: string;
  nodeName?: string;
  sourceId?: string;
  sourceName?: string;
  sourceType?: T.IngestionSourceType;
  token?: string;
  sourceEventId?: string;
}

interface ObserverBatchIngestBody {
  events?: IngestBody[];
  batchId?: string;
  payloadDigest?: string;
  durableReplay?: boolean;
}

const CLICKHOUSE_EVENT_BUFFER_FULL = 'ANYSENTRY_CLICKHOUSE_EVENT_BUFFER_FULL';
const EVENT_REVISION_CONFLICT = 'ANYSENTRY_EVENT_REVISION_CONFLICT';
const OBSERVER_BATCH_RETRY_AFTER_MS = 1_000;
const OBSERVER_BATCH_MAX_EVENTS = 256;
const OBSERVER_BATCH_MAX_BYTES = 15 * 1024 * 1024;
const OBSERVER_BATCH_CONTROL_YIELD_EVERY = 32;
const OBSERVER_BATCH_ID_MAX_LENGTH = 200;
const OBSERVER_BATCH_DIGEST = /^[a-f0-9]{64}$/u;
const OBSERVER_SOURCE_PAYLOAD_SHA256_ATTRIBUTE = 'anysentry.observer.source_payload_sha256';
const CANONICAL_REVISION_MAX = 1_000_000;

function boundedCanonicalRevision(value: unknown, fallback = 1): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 1
    ? Math.min(CANONICAL_REVISION_MAX, numeric)
    : fallback;
}

/** Query contract shared by all additive Canonical entity GET resources. */
interface CanonicalEntityQuery {
  limit: number;
  offset: number;
  cursor?: string;
  revision?: number;
  includeShadow: boolean;
  includeCoverage: boolean;
  logicalAgentId?: string;
  logicalAgentCandidateId?: string;
  logicalDefinitionId?: string;
  tenantId?: string;
  ownerId?: string;
  workspacePath?: string;
  product?: string;
  environment?: string;
  environmentId?: string;
  agentAssetId?: string;
  agentInstanceId?: string;
  runtimeInstanceId?: string;
  sessionId?: string;
  sourceId?: string;
  collectorId?: string;
  classification?: T.AgentClassification;
  coverageStatus?: string;
  lifecycleScope?: 'running' | 'history' | 'all';
  q?: string;
  timeType?: T.SecurityTimeFilter['timeType'];
  startTime?: string;
  endTime?: string;
  snapshotAsOf?: string;
  classificationView?: T.ClassificationView;
}

interface CanonicalSemanticTimelineCandidate {
  session: T.CanonicalSessionResource;
  event: T.AgentSemanticEvent;
}

interface CanonicalSemanticTimelineSearch {
  candidates: CanonicalSemanticTimelineCandidate[];
  scanned: number;
  truncated: boolean;
  failed: number;
  /** A scoped stable `se_…` match is exact even when the bounded candidate list was capped. */
  exactUnique?: boolean;
}

interface CanonicalDirectoryCacheEntry {
  value: T.AgentConversationDirectoryListV4;
  expiresAt: number;
  bytes: number;
}

interface CanonicalSessionProjection {
  items: T.CanonicalSessionResource[];
  coverage: T.CanonicalEntityCoverage;
  dataSource: string;
  revision: number;
}

interface CanonicalSessionCacheEntry {
  value: CanonicalSessionProjection;
  expiresAt: number;
  bytes: number;
}

const CANONICAL_ENTITY_LIMIT_MAX = 500;
const CANONICAL_ENTITY_OFFSET_MAX = 1_000_000;
const CANONICAL_ENTITY_CURSOR_PREFIX = 'ce1:';
// Canonical entity reads are metadata projections, not a reason to repeatedly fan out to the
// ClickHouse-backed conversation projector.  Keep a very short, bounded cache so the UI's
// concurrent list/detail requests share one immutable snapshot while still observing new ingest
// revisions promptly.  The key includes the operator identity and every canonical filter; no
// credential value is ever retained in the cache.
const CANONICAL_DIRECTORY_CACHE_TTL_MS = 2_000;
const CANONICAL_DIRECTORY_CACHE_MAX_ENTRIES = 8;
const CANONICAL_DIRECTORY_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const CANONICAL_RUNTIME_STATE_READ_LIMIT = 20_000;
const CANONICAL_SEMANTIC_SESSION_SCAN_MAX = 64;
const CANONICAL_SEMANTIC_SCAN_CONCURRENCY = 4;
const CANONICAL_SESSION_CACHE_TTL_MS = 2_000;
const CANONICAL_SESSION_CACHE_MAX_ENTRIES = 4;
const CANONICAL_SESSION_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const CANONICAL_DIRECTORY_INFLIGHT_MAX = 16;
const CANONICAL_SESSION_INFLIGHT_MAX = 16;
const CANONICAL_EVIDENCE_PROJECTION_TIMEOUT_MS = 10_000;
const CANONICAL_DIRECTORY_PROJECTION_TIMEOUT_MS = boundedControllerEnvInt(
  'ANYSENTRY_CANONICAL_DIRECTORY_PROJECTION_TIMEOUT_MS',
  2_000,
  250,
  10_000,
);
const CANONICAL_SESSION_PROJECTION_TIMEOUT_MS = boundedControllerEnvInt(
  'ANYSENTRY_CANONICAL_SESSION_PROJECTION_TIMEOUT_MS',
  2_000,
  250,
  10_000,
);
const CANONICAL_SEMANTIC_TIMELINE_TIMEOUT_MS = boundedControllerEnvInt(
  'ANYSENTRY_CANONICAL_SEMANTIC_TIMELINE_TIMEOUT_MS',
  2_000,
  250,
  10_000,
);
const CANONICAL_SEMANTIC_EVIDENCE_TIMEOUT_MS = boundedControllerEnvInt(
  'ANYSENTRY_CANONICAL_SEMANTIC_EVIDENCE_TIMEOUT_MS',
  2_000,
  250,
  10_000,
);
const CANONICAL_SEMANTIC_ALIAS_TIMEOUT_MS = boundedControllerEnvInt(
  'ANYSENTRY_CANONICAL_SEMANTIC_ALIAS_TIMEOUT_MS',
  500,
  100,
  2_000,
);
// Canonical fact/relationship point and list reads are secondary projections. Keep their
// database wait bounded so a slow PostgreSQL side lane cannot turn a detail request into a
// 10-second socket timeout; the controller falls back to the process-local immutable hot stores.
const CANONICAL_STORE_READ_TIMEOUT_MS = boundedControllerEnvInt(
  'ANYSENTRY_CANONICAL_STORE_READ_TIMEOUT_MS',
  1_000,
  100,
  5_000,
);
const CANONICAL_KERNEL_FALLBACK_LOOKBACK_MS = boundedControllerEnvInt(
  'ANYSENTRY_CANONICAL_KERNEL_FALLBACK_LOOKBACK_MS',
  2 * 60 * 60_000,
  60_000,
  7 * 24 * 60 * 60_000,
);

function boundedControllerEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.trunc(parsed)))
    : fallback;
}

function boundedCanonicalStoreLimit(value: string | undefined, fallback = 500): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(10_000, Math.max(1, Math.trunc(parsed)))
    : fallback;
}

function canonicalQueryScalar(
  query: Record<string, unknown> | undefined,
  keys: readonly string[],
  max = 512,
): string | undefined {
  const input = query ?? {};
  let supplied: unknown;
  let suppliedKey: string | undefined;
  for (const key of keys) {
    if (input[key] !== undefined) {
      supplied = input[key];
      suppliedKey = key;
      break;
    }
  }
  if (supplied === undefined) return undefined;
  if (Array.isArray(supplied)) {
    throw new BadRequestException(`${suppliedKey ?? keys[0]} must be a scalar`);
  }
  const value = strictIdentityText(supplied, max);
  if (!value) throw new BadRequestException(`${suppliedKey ?? keys[0]} is invalid`);
  return value;
}

function canonicalQueryBoolean(
  query: Record<string, unknown> | undefined,
  keys: readonly string[],
  fallback: boolean,
): boolean {
  const value = canonicalQueryScalar(query, keys, 16);
  if (value === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  throw new BadRequestException(`${keys[0]} must be true or false`);
}

function canonicalQueryInteger(
  query: Record<string, unknown> | undefined,
  keys: readonly string[],
  fallback: number,
  min: number,
  max: number,
): number {
  const value = canonicalQueryScalar(query, keys, 32);
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new BadRequestException(`${keys[0]} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new BadRequestException(`${keys[0]} must be between ${min} and ${max}`);
  }
  return parsed;
}

function encodeCanonicalCursor(offset: number): string {
  return Buffer.from(`${CANONICAL_ENTITY_CURSOR_PREFIX}${offset}`, 'utf8').toString('base64url');
}

function decodeCanonicalCursor(value: string | undefined): number | undefined {
  if (!value) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    throw new BadRequestException('cursor is invalid');
  }
  if (!new RegExp(`^${CANONICAL_ENTITY_CURSOR_PREFIX}\\d+$`, 'u').test(decoded)) {
    throw new BadRequestException('cursor is invalid');
  }
  const offset = Number(decoded.slice(CANONICAL_ENTITY_CURSOR_PREFIX.length));
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > CANONICAL_ENTITY_OFFSET_MAX) {
    throw new BadRequestException('cursor is invalid');
  }
  return offset;
}

function parseCanonicalEntityQuery(input?: Record<string, unknown>): CanonicalEntityQuery {
  const query = input ?? {};
  const cursor = canonicalQueryScalar(query, ['cursor'], 128);
  const offset = decodeCanonicalCursor(cursor)
    ?? canonicalQueryInteger(query, ['offset'], 0, 0, CANONICAL_ENTITY_OFFSET_MAX);
  if (cursor && query.offset !== undefined) throw new BadRequestException('cursor and offset are mutually exclusive');
  const revisionText = canonicalQueryScalar(query, ['revision', 'resolutionRevision'], 32);
  const revision = revisionText === undefined
    ? undefined
    : (() => {
        if (!/^\d+$/u.test(revisionText)) throw new BadRequestException('revision is invalid');
        const value = Number(revisionText);
        if (!Number.isSafeInteger(value) || value < 1 || value > CANONICAL_REVISION_MAX) {
          throw new BadRequestException('revision is invalid');
        }
        return value;
      })();
  const classificationText = canonicalQueryScalar(query, ['classification'], 32);
  const classification = classificationText === undefined
    ? undefined
    : ['confirmed_agent', 'probable_agent', 'unknown', 'non_agent'].includes(classificationText)
      ? classificationText as T.AgentClassification
      : (() => { throw new BadRequestException('classification is invalid'); })();
  const lifecycleText = canonicalQueryScalar(query, ['lifecycleScope', 'lifecycle'], 32);
  const lifecycleScope = lifecycleText === undefined
    ? 'all' as const
    : ['running', 'history', 'all'].includes(lifecycleText)
      ? lifecycleText as 'running' | 'history' | 'all'
      : (() => { throw new BadRequestException('lifecycleScope is invalid'); })();
  const timeTypeText = canonicalQueryScalar(query, ['timeType'], 32);
  const timeTypes = ['last_30m', 'last_1h', 'last_2h', 'last_3h', 'last_1d', 'last_7d', 'last_30d', 'custom'];
  const timeType = timeTypeText === undefined
    ? undefined
    : timeTypes.includes(timeTypeText)
      ? timeTypeText as T.SecurityTimeFilter['timeType']
      : (() => { throw new BadRequestException('timeType is invalid'); })();
  const classificationViewText = canonicalQueryScalar(query, ['classificationView'], 32);
  const classificationView = classificationViewText === undefined
    ? undefined
    : ['as_observed', 'current_effective'].includes(classificationViewText)
      ? classificationViewText as T.ClassificationView
      : (() => { throw new BadRequestException('classificationView is invalid'); })();
  const scalar = (keys: readonly string[], max = 512) => canonicalQueryScalar(query, keys, max);
  return {
    limit: canonicalQueryInteger(query, ['limit'], 100, 1, CANONICAL_ENTITY_LIMIT_MAX),
    offset,
    ...(cursor ? { cursor } : {}),
    ...(revision !== undefined ? { revision } : {}),
    includeShadow: canonicalQueryBoolean(query, ['includeShadow', 'shadow'], true),
    includeCoverage: canonicalQueryBoolean(query, ['includeCoverage', 'coverage'], true),
    logicalAgentId: scalar(['logicalAgentId', 'logical-agent-id']),
    logicalAgentCandidateId: scalar(['logicalAgentCandidateId', 'candidateId']),
    logicalDefinitionId: scalar(['logicalDefinitionId', 'definitionId']),
    tenantId: scalar(['tenantId', 'tenant']),
    ownerId: scalar(['ownerId', 'owner']),
    workspacePath: scalar(['workspacePath', 'workspace']),
    product: scalar(['product', 'agentProduct']),
    environment: scalar(['environment']),
    environmentId: scalar(['environmentId']),
    agentAssetId: scalar(['agentAssetId']),
    agentInstanceId: scalar(['agentInstanceId']),
    runtimeInstanceId: scalar(['runtimeInstanceId']),
    sessionId: scalar(['sessionId']),
    sourceId: scalar(['sourceId']),
    collectorId: scalar(['collectorId']),
    classification,
    coverageStatus: scalar(['coverageStatus'], 64),
    lifecycleScope,
    q: scalar(['q', 'query'], 240),
    timeType,
    startTime: scalar(['startTime'], 80),
    endTime: scalar(['endTime'], 80),
    snapshotAsOf: scalar(['snapshotAsOf', 'asOf'], 80),
    classificationView,
  };
}

function canonicalPage<Item>(
  items: Item[],
  query: CanonicalEntityQuery,
): { items: Item[]; total: number; pagination: T.CanonicalEntityPagination } {
  const total = items.length;
  const pageItems = items.slice(query.offset, query.offset + query.limit);
  const nextOffset = query.offset + pageItems.length;
  return {
    items: pageItems,
    total,
    pagination: {
      limit: query.limit,
      offset: query.offset,
      hasMore: nextOffset < total,
      ...(nextOffset < total ? { nextCursor: encodeCanonicalCursor(nextOffset) } : {}),
    },
  };
}

function canonicalCoverage(
  partial: boolean,
  reasons: string[],
  source: string,
): T.CanonicalEntityCoverage {
  return {
    status: partial ? 'partial' : 'complete',
    reasons: [...new Set(reasons.filter(Boolean))].slice(0, 64),
    source,
  };
}

function degradedCanonicalTimeline(
  conversationId: string,
  query: CanonicalEntityQuery,
  revision: number,
): T.AgentConversationTimelineV3 {
  const now = new Date().toISOString();
  const requestKey = createHash('sha256').update([
    'canonical-session-timeline-fallback',
    conversationId,
    query.timeType ?? '',
    query.startTime ?? '',
    query.endTime ?? '',
    query.snapshotAsOf ?? '',
    String(revision),
  ].join('\u0000')).digest('hex').slice(0, 32);
  return {
    apiVersion: 3,
    requestKey,
    requestedConversationId: conversationId,
    canonicalConversationId: conversationId,
    resolutionRevision: revision,
    timelineVersion: 3,
    segments: [],
    turns: [],
    interactionIds: [],
    parserId: 'anysentry.canonical-session-timeline-fallback',
    parserVersion: 1,
    contextReplaySummaries: [],
    technicalActivitySummaries: [],
    dataSource: 'hot_ring',
    classificationView: query.classificationView ?? 'as_observed',
    reviewRevision: 0,
    coverage: {
      requestedFrom: query.startTime ?? now,
      requestedTo: query.endTime ?? now,
      snapshotAsOf: query.snapshotAsOf ?? now,
      asOf: query.snapshotAsOf ?? now,
      completeness: 'partial',
      partial: true,
      partialReason: 'projection_timeout',
      source: 'memory_hot_ring',
      totalMode: 'omitted',
    },
    updateTime: now,
  };
}

function canonicalSessionResourceFromSummary(
  summary: T.AgentConversationSummary,
  revision: number,
): T.CanonicalSessionResource {
  const sessionId = summary.sessionId ?? summary.conversationId;
  return {
    schemaVersion: 'anysentry.session.v1',
    sessionId,
    ...(summary.sessionId && summary.sessionId !== summary.conversationId
      ? { canonicalSessionId: summary.conversationId } : {}),
    ...(summary.sessionKey ? { sessionKey: summary.sessionKey } : {}),
    ...(summary.providerSessionIdHash ? { providerSessionIdHash: summary.providerSessionIdHash } : {}),
    conversationId: summary.conversationId,
    ...(summary.logicalAgentId ? { logicalAgentId: summary.logicalAgentId } : {}),
    ...(summary.logicalAgentCandidateId ? { logicalAgentCandidateId: summary.logicalAgentCandidateId } : {}),
    ...(summary.logicalDefinitionId ? { logicalDefinitionId: summary.logicalDefinitionId } : {}),
    ...(summary.logicalScopeMode ? { logicalScopeMode: summary.logicalScopeMode } : {}),
    ...(summary.logicalIdentityAuthority ? { logicalIdentityAuthority: summary.logicalIdentityAuthority } : {}),
    ...(summary.tenantId ? { tenantId: summary.tenantId } : {}),
    ...(summary.ownerId ? { ownerId: summary.ownerId } : {}),
    ...(summary.agentProduct ? { agentProduct: summary.agentProduct } : {}),
    ...(summary.environment ? { environment: summary.environment } : {}),
    ...(summary.workspacePath ? { workspacePath: summary.workspacePath } : {}),
    agentAssetIds: [...new Set(summary.agentAssetIds ?? [summary.agentAssetId])]
      .filter((value): value is string => Boolean(value))
      .slice(0, 256),
    agentInstanceIds: [...summary.agentInstanceIds].slice(0, 512),
    segmentIds: [],
    interactionIds: [],
    ...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
    ...(summary.canonicalParentSessionId ? { canonicalParentSessionId: summary.canonicalParentSessionId } : {}),
    ...(summary.sessionIdentityQuality ? { sessionIdentityQuality: summary.sessionIdentityQuality } : {}),
    ...(summary.sessionMode ? { sessionMode: summary.sessionMode } : {}),
    ...(summary.sessionLifecycle ? { sessionLifecycle: summary.sessionLifecycle } : {}),
    ...(summary.startedAtUnixNs ? { startedAtUnixNs: summary.startedAtUnixNs } : {}),
    ...(summary.lastActivityAtUnixNs ? { lastActivityAtUnixNs: summary.lastActivityAtUnixNs } : {}),
    turnCount: summary.turnCount,
    modelCallCount: summary.modelCallCount,
    toolCallCount: summary.toolCallCount,
    toolResultCount: summary.toolResultCount,
    errorCount: summary.errorCount,
    usage: structuredClone(summary.usage),
    coverage: structuredClone(summary.coverage),
    sourceRefs: canonicalConversationSourceRefs(summary).slice(0, 64),
    resolutionRevision: revision,
  };
}

/**
 * Source/collector filters are security scopes, not display hints.  Some projections (notably a
 * logical/session row assembled from conversation data) do not yet carry the authenticated
 * source identity.  Mark those reads partial instead of treating an unavailable dimension as a
 * wildcard or claiming complete coverage.
 */
function canonicalScopeCoverage(
  query: CanonicalEntityQuery,
  coverage: T.CanonicalEntityCoverage,
  provenanceAvailable: boolean | { sourceId?: boolean; collectorId?: boolean },
): T.CanonicalEntityCoverage {
  const sourceAvailable = typeof provenanceAvailable === 'boolean'
    ? provenanceAvailable
    : provenanceAvailable.sourceId === true;
  const collectorAvailable = typeof provenanceAvailable === 'boolean'
    ? provenanceAvailable
    : provenanceAvailable.collectorId === true;
  const sourceGap = query.sourceId !== undefined && !sourceAvailable;
  const collectorGap = query.collectorId !== undefined && !collectorAvailable;
  if (!sourceGap && !collectorGap) {
    return coverage;
  }
  return {
    ...coverage,
    status: 'partial',
    reasons: [...new Set([
      ...coverage.reasons,
      sourceGap ? 'source_scope_provenance_unavailable' : '',
      collectorGap ? 'collector_scope_provenance_unavailable' : '',
    ].filter(Boolean))].slice(0, 64),
  };
}

function canonicalScopeMatches(
  value: {
    logicalAgentId?: string;
    logicalAgentCandidateId?: string;
    logicalDefinitionId?: string;
    tenantId?: string;
    ownerId?: string;
    workspacePath?: string;
    environment?: string;
    environmentId?: string;
    agentAssetId?: string;
    agentInstanceId?: string;
    runtimeInstanceId?: string;
    sessionId?: string;
    agentAssetIds?: readonly string[];
    agentInstanceIds?: readonly string[];
    runtimeInstanceIds?: readonly string[];
    sessionIds?: readonly string[];
    product?: string;
    classification?: T.AgentClassification;
    coverageStatus?: string;
    sourceId?: string;
    collectorId?: string;
    sourceIds?: readonly string[];
    collectorIds?: readonly string[];
    q?: string;
  },
  query: CanonicalEntityQuery,
): boolean {
  const equals = (actual: unknown, expected: string | undefined) =>
    expected === undefined || String(actual ?? '').toLowerCase() === expected.toLowerCase();
  const contains = (actual: unknown, expected: string | undefined) =>
    expected === undefined || String(actual ?? '').toLowerCase().includes(expected.toLowerCase());
  const includes = (actual: readonly string[] | undefined, expected: string | undefined) =>
    expected === undefined || Boolean(actual?.some((item) => item.toLowerCase() === expected.toLowerCase()));
  return equals(value.logicalAgentId, query.logicalAgentId)
    && equals(value.logicalAgentCandidateId, query.logicalAgentCandidateId)
    && equals(value.logicalDefinitionId, query.logicalDefinitionId)
    && equals(value.tenantId, query.tenantId)
    && equals(value.ownerId, query.ownerId)
    && equals(value.workspacePath, query.workspacePath)
    && equals(value.environment, query.environment)
    && equals(value.environmentId, query.environmentId)
    && (query.agentAssetId === undefined
      || equals(value.agentAssetId, query.agentAssetId)
      || Boolean(value.agentAssetIds?.some((candidate) => equals(candidate, query.agentAssetId))))
    && (query.agentInstanceId === undefined
      || equals(value.agentInstanceId, query.agentInstanceId)
      || Boolean(value.agentInstanceIds?.some((candidate) => equals(candidate, query.agentInstanceId))))
    && (query.runtimeInstanceId === undefined
      || equals(value.runtimeInstanceId, query.runtimeInstanceId)
      || Boolean(value.runtimeInstanceIds?.some((candidate) => equals(candidate, query.runtimeInstanceId))))
    && (query.sessionId === undefined
      || equals(value.sessionId, query.sessionId)
      || Boolean(value.sessionIds?.some((candidate) => equals(candidate, query.sessionId))))
    && contains(value.product, query.product)
    && equals(value.classification, query.classification)
    && equals(value.coverageStatus, query.coverageStatus)
    // A source/collector scope must never degrade to an unbounded wildcard when the read model
    // lacks provenance.  `includes(undefined, requested)` is false, so the caller gets an empty
    // result (and a coverage reason) until that provenance is materialized.
    && (query.sourceId === undefined
      ? true
      : equals(value.sourceId, query.sourceId) || includes(value.sourceIds, query.sourceId))
    && (query.collectorId === undefined
      ? true
      : equals(value.collectorId, query.collectorId) || includes(value.collectorIds, query.collectorId))
    && contains(JSON.stringify(value), query.q);
}

function canonicalMillisToUnixNs(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return (BigInt(Math.trunc(value)) * 1_000_000n).toString();
}

function canonicalRuntimeEnvironment(
  record: T.AgentRuntimeInstanceRecord,
): T.LogicalAgentConversationDirectoryItem['environment'] {
  if (record.workloadRef?.environment) return record.workloadRef.environment;
  const physical = String(record.physicalWorkloadId ?? '').toLowerCase();
  if (physical.includes('kubernetes') || physical.includes('pod')) return 'kubernetes';
  if (physical.includes('docker') || physical.includes('container')) return 'docker';
  return 'host';
}

function canonicalRuntimeProcessKey(record: T.AgentRuntimeInstanceRecord): string | undefined {
  return deriveProcessGenerationKey({
    hostId: record.hostId,
    bootId: record.bootId,
    pid: record.rootPid,
    startTimeTicks: record.rootStartTimeTicks,
  });
}

function canonicalSessionIdentity(summary: T.AgentConversationSummary): string {
  return summary.sessionId ?? summary.conversationId;
}

function canonicalSemanticKindForTimeline(kind: SemanticRecord['kind']): T.AgentSemanticEventKind | undefined {
  if (kind === 'tool_call') return 'tool_call';
  if (kind === 'tool_result') return 'tool_result';
  if (kind === 'message') return undefined;
  return undefined;
}

function canonicalSemanticRecordTouchesEvent(record: SemanticRecord, event: T.AgentSemanticEvent): boolean {
  const kind = canonicalSemanticKindForTimeline(record.kind);
  // Tool intent/result records are separate immutable rows.  An interaction can also contain
  // message rows, so an interaction-id match alone must not make a message (or the paired result)
  // an alias for a ToolCall.
  if ((event.kind === 'tool_call' || event.kind === 'tool_result') && kind !== event.kind) {
    return false;
  }
  if (kind && kind !== event.kind) return false;
  if (record.toolCallId && record.toolCallId !== event.toolCallId) return false;
  const interactionRefs = new Set([...record.sourceRefs, ...record.derivedFrom]);
  const interactionMatch = event.sourceInteractionIds.some((id) => interactionRefs.has(id));
  const toolMatch = Boolean(record.toolCallId && event.toolCallId === record.toolCallId);
  return interactionMatch || toolMatch;
}

function canonicalSemanticRecordTouchesSession(
  record: SemanticRecord,
  session: T.CanonicalSessionResource,
): boolean {
  const sessionIds = new Set([
    session.sessionId,
    session.canonicalSessionId,
    session.conversationId,
  ].filter((value): value is string => Boolean(value)));
  if (record.sessionId && sessionIds.has(record.sessionId)) return true;
  if (record.canonicalSessionId && sessionIds.has(record.canonicalSessionId)) return true;
  return session.interactionIds.some((interactionId) =>
    record.sourceRefs.includes(interactionId) || record.derivedFrom.includes(interactionId));
}

/**
 * Reconstruct a metadata-only KernelFact from the immutable compatibility event when the
 * relational canonical side lane is temporarily unavailable.  The event already carries the
 * server-assigned fact ID and raw/source references; this helper never copies command text,
 * prompt content, or producer claims into the canonical response.
 */
function kernelFactFromCompatibilityEvent(
  event: T.JudgedEvent,
  requestedFactId: string,
): KernelFact | undefined {
  if (!/^kf_[a-f0-9]{24}$/u.test(requestedFactId) || event.kernelFactId !== requestedFactId) return undefined;
  const observedAtUnixNs = /^\d{9,41}$/u.test(event.eventAtUnixNs ?? '')
    ? event.eventAtUnixNs!
    : Number.isSafeInteger(event.at) && event.at >= 0
      ? (BigInt(event.at) * 1_000_000n).toString()
      : undefined;
  if (!observedAtUnixNs) return undefined;
  const sourceRefs = [...new Set([
    event.rawObservationId,
    event.sourceEventId,
    event.eventId,
  ].filter((value): value is string => Boolean(value)))].slice(0, 8);
  if (sourceRefs.length === 0) return undefined;
  const processGenerationKey = event.process?.processGenerationKey
    ?? event.attribution?.processGenerationKey;
  const parentProcessGenerationKey = event.process?.parentProcessGenerationKey
    ?? event.attribution?.parentProcessGenerationKey;
  const fact = {
    schemaVersion: 'anysentry.kernel_fact.v1' as const,
    factId: requestedFactId,
    kind: event.eventKind === 'ProcessExit'
      ? 'exit'
      : event.eventKind === 'ToolExec'
        ? 'exec'
        : event.eventKind.toLowerCase().includes('network') || event.eventKind === 'Egress'
          ? 'network'
          : event.eventKind.toLowerCase().includes('dns')
            ? 'dns'
            : event.eventKind.toLowerCase().includes('security')
              ? 'security'
              : event.eventKind.toLowerCase().includes('file')
                ? 'file'
                : 'unknown',
    authority: event.source === 'observer' ? 'attested_observer' as const : 'server_process_graph' as const,
    sourceRefs,
    derivedFrom: [event.rawObservationId ?? event.eventId],
    observedAtUnixNs,
    ...(processGenerationKey && /^pgk_[a-f0-9]{24}$/u.test(processGenerationKey)
      ? { processGenerationKey } : {}),
    ...(parentProcessGenerationKey && /^pgk_[a-f0-9]{24}$/u.test(parentProcessGenerationKey)
      ? { parentProcessGenerationKey } : {}),
    ...(event.runtimeInstanceId ? { scope: event.runtimeInstanceId } : {}),
    eventId: event.eventId,
    status: event.eventKind === 'ProcessExit'
      ? 'completed' as const
      : event.decisionStatus === 'failed' ? 'failed' as const : 'observed' as const,
  } satisfies KernelFact;
  const checked = validateKernelFact(fact);
  return checked.ok ? checked.value : undefined;
}

function canonicalConversationSourceRefs(summary: T.AgentConversationSummary): string[] {
  return [...new Set([
    `conversation:${summary.conversationId}`,
    ...summary.agentInstanceIds.slice(0, 16).map((id) => `agent-instance:${id}`),
  ])].slice(0, 32);
}

function canonicalCoverageFromSummaries(
  summaries: readonly T.AgentConversationSummary[],
  fallbackSource: string,
): T.CanonicalEntityCoverage {
  if (summaries.length === 0) {
    return canonicalCoverage(true, ['no_conversation_projection'], fallbackSource);
  }
  const partial = summaries.some((summary) => summary.coverage.status !== 'complete');
  return canonicalCoverage(
    partial,
    summaries.flatMap((summary) => summary.coverage.reasons),
    fallbackSource,
  );
}

function canonicalLifecycleMatches(
  state: T.AgentRuntimeState,
  scope: CanonicalEntityQuery['lifecycleScope'],
): boolean {
  if (scope === 'running') return state === 'running' || state === 'unobserved';
  if (scope === 'history') return state === 'exited' || state === 'lost';
  return true;
}

/**
 * Errors from the read-only projection lane are degradable. Keep validation/programmer errors
 * visible, but turn backend timeout, memory, and temporary-unavailable failures into explicit
 * CoverageGap metadata rather than an opaque HTTP 500 from a deep-link inspector.
 */
function isCanonicalProjectionDegradation(error: unknown): boolean {
  if (error instanceof ServiceUnavailableException || error instanceof NotFoundException) return true;
  if (!(error instanceof Error)) return false;
  return /(?:timeout|timed out|memory limit|clickhouse|postgres(?:ql)?|projection.+busy|temporarily unavailable)/iu.test(error.message);
}

function withCanonicalProjectionTimeout<T>(
  operation: Promise<T>,
  timeoutMs = CANONICAL_EVIDENCE_PROJECTION_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ServiceUnavailableException('Canonical evidence projection timed out')), timeoutMs);
    timer.unref();
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
const OBSERVER_BATCH_ID_DIGEST_CACHE_SIZE = 10_000;
const OBSERVER_BATCH_ID_DIGEST_CACHE_BYTES = 2 * 1024 * 1024;
const OBSERVER_INGRESS_CACHE_TTL_MS = 15 * 60_000;
const observerBatchIdDigests = new Map<string, { digest: string; expiresAt: number; bytes: number }>();
let observerBatchIdDigestBytes = 0;
let observerBatchIdDigestEvicted = 0;
let observerBatchIdDigestExpired = 0;
const OBSERVER_BATCH_RESULT_CACHE_SIZE = 512;
const OBSERVER_BATCH_RESULT_CACHE_BYTES = 16 * 1024 * 1024;
const observerBatchResults = new Map<string, {
  digest: string;
  result: T.ObserverBatchIngestResult;
  bytes: number;
  expiresAt: number;
}>();
let observerBatchResultEvicted = 0;
let observerBatchResultExpired = 0;

function yieldObserverBatchControl(index: number): Promise<void> | undefined {
  if (index === 0 || index % OBSERVER_BATCH_CONTROL_YIELD_EVERY !== 0) return undefined;
  return new Promise((resolve) => setImmediate(resolve));
}
let observerBatchResultBytes = 0;
const UNIVERSAL_EVENT_IDEMPOTENCY_CACHE_SIZE = 20_000;
const universalEventIdempotency = new Map<string, {
  digest: string;
  item: T.UniversalIngestResultItem;
  bytes: number;
  expiresAt: number;
}>();
let universalEventIdempotencyBytes = 0;
let universalEventIdempotencyEvicted = 0;
let universalEventIdempotencyExpired = 0;
// A compatibility EventMeta still requires a sessionId even when an Observer line has no
// provider/session anchor.  Keep that fallback unique per request boundary; hashing only the line
// would incorrectly merge two stateless POSTs carrying the same payload.  Producer event IDs and
// interaction IDs remain deterministic when present, so retries can still replay the same identity.
let ephemeralMetaSequence = 0;

function isClickHouseEventBufferFull(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === CLICKHOUSE_EVENT_BUFFER_FULL &&
    'retrySafe' in error &&
    (error as { retrySafe?: unknown }).retrySafe === true,
  );
}

function isEventRevisionConflict(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === EVENT_REVISION_CONFLICT
  );
}

/**
 * A post-commit projection failure is an observability degradation, not a reason to replay the
 * immutable Observer fact.  Keep the classification deliberately narrow and metadata-only: error
 * messages from database clients may contain SQL, endpoint, or credential-bearing fragments and
 * must never be copied into a CoverageGap or an ingest response.
 */
function observerProjectionFailureReason(error: unknown): 'timeout' | 'storage_unavailable' {
  const value = error && typeof error === 'object' ? error as { code?: unknown; name?: unknown } : {};
  const code = typeof value.code === 'string' ? value.code : '';
  const name = typeof value.name === 'string' ? value.name : '';
  // PostgreSQL uses SQLSTATE 57014 for a cancelled statement and often puts the literal
  // "statement timeout" only in the message.  Inspect it for classification, but never persist
  // the message itself (it may contain a query or endpoint fragment).
  const message = error instanceof Error ? error.message : '';
  return code === '57014'
    || /(?:timeout|timed[_ -]?out|etimedout|deadline|statement[_ -]?cancel)/iu.test(`${code} ${name} ${message}`)
    ? 'timeout'
    : 'storage_unavailable';
}

function observerProjectionFailureCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/u.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/u.test(name)) return name;
  }
  return 'projection_error';
}

const DIGEST_SECRET_KEY = /(?:token|authorization|cookie|password|secret|credential|api[_-]?key|access[_-]?key|refresh[_-]?token|private[_-]?key)/iu;
const DIGEST_CONTENT_KEY = /(?:^|[_-])(?:body|prompt|content|messages?|input|output|response|result|data)(?:$|[_-])/iu;

function digestSafeText(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED]')
    .replace(/((?:token|authorization|cookie|password|secret|api[_-]?key|credential)\s*[:=]\s*)[^\s,;}]+/giu, '$1[REDACTED]')
    .replace(/\b(?:sk|pk|key|token)-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]');
}

/**
 * Build a deterministic idempotency projection without hashing credentials or transcript bodies.
 * The wire payload itself is still validated/forwarded through the existing bounded path; this
 * projection is used only for cache keys and persisted provenance digests.  Raw `line` values are
 * parsed when possible so nested token/header fields cannot sneak into the digest.
 */
function digestSafeValue(value: unknown, key = '', depth = 0, redactContent = true): unknown {
  if (depth > 8) return { type: 'depth_limited' };
  if (DIGEST_SECRET_KEY.test(key)) {
    return { type: 'redacted_secret', valueType: Array.isArray(value) ? 'array' : typeof value };
  }
  const normalizedKey = key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
  if (redactContent && DIGEST_CONTENT_KEY.test(normalizedKey)) {
    const safeContent = digestSafeValue(value, 'value', depth + 1, false);
    const serialized = JSON.stringify(safeContent);
    return {
      type: 'redacted_content',
      valueType: Array.isArray(value) ? 'array' : typeof value,
      bytes: typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : undefined,
      // Hash only the recursively secret-stripped representation. This preserves idempotency
      // conflict detection for equal-length prompt/body changes without persisting plaintext or a
      // credential-derived hash.
      digest: createHash('sha256').update(serialized).digest('hex'),
    };
  }
  if (typeof value === 'string' && key === 'line') {
    try {
      return digestSafeValue(JSON.parse(value), 'line_json', depth + 1, redactContent);
    } catch {
      const safeLine = digestSafeText(value);
      return {
        type: 'opaque_line',
        bytes: Buffer.byteLength(value, 'utf8'),
        digest: createHash('sha256').update(safeLine).digest('hex'),
      };
    }
  }
  if (Array.isArray(value)) {
    return value.slice(0, 512).map((item) => digestSafeValue(item, key, depth + 1, redactContent));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 512)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([childKey, childValue]) => [childKey, digestSafeValue(childValue, childKey, depth + 1, redactContent)]));
  }
  if (typeof value === 'string' && value.length > 64 * 1024) {
    return { type: 'bounded_string', bytes: Buffer.byteLength(value, 'utf8') };
  }
  if (typeof value === 'string') return digestSafeText(value);
  return value;
}

function safePayloadDigest(value: unknown): string {
  // JSON.stringify(undefined) returns undefined, which crypto.Hash.update rejects.  Empty
  // semantic events are valid metadata-only observations (for example an AgentTool lifecycle
  // marker with IDs in attributes); hash the same empty representation used by eventInner instead
  // of turning a boundary omission into HTTP 500.
  const serialized = JSON.stringify(digestSafeValue(value)) ?? '';
  return createHash('sha256').update(serialized).digest('hex');
}

function observerBatchPayload(events: readonly IngestBody[]): { json: string; bytes: number; digest: string; safeDigest: string } {
  const json = JSON.stringify(events);
  return {
    json,
    bytes: Buffer.byteLength(json, 'utf8'),
    digest: createHash('sha256').update(json).digest('hex'),
    safeDigest: safePayloadDigest(events),
  };
}

function purgeIngressCaches(now = Date.now()): void {
  for (const [key, entry] of observerBatchIdDigests) {
    if (entry.expiresAt > now) continue;
    observerBatchIdDigests.delete(key);
    observerBatchIdDigestBytes = Math.max(0, observerBatchIdDigestBytes - entry.bytes);
    observerBatchIdDigestExpired += 1;
  }
  for (const [key, entry] of observerBatchResults) {
    if (entry.expiresAt > now) continue;
    observerBatchResults.delete(key);
    observerBatchResultBytes = Math.max(0, observerBatchResultBytes - entry.bytes);
    observerBatchResultExpired += 1;
  }
  for (const [key, entry] of universalEventIdempotency) {
    if (entry.expiresAt > now) continue;
    universalEventIdempotency.delete(key);
    universalEventIdempotencyBytes = Math.max(0, universalEventIdempotencyBytes - entry.bytes);
    universalEventIdempotencyExpired += 1;
  }
}

function rememberObserverBatchDigest(batchId: string, digest: string): void {
  purgeIngressCaches();
  const existing = observerBatchIdDigests.get(batchId);
  if (existing && existing.digest !== digest) {
    throw new BadRequestException('observer batchId conflicts with a different payloadDigest');
  }
  if (existing) {
    observerBatchIdDigests.delete(batchId);
    observerBatchIdDigestBytes = Math.max(0, observerBatchIdDigestBytes - existing.bytes);
  }
  const bytes = Buffer.byteLength(batchId, 'utf8') + Buffer.byteLength(digest, 'utf8') + 64;
  observerBatchIdDigests.set(batchId, {
    digest,
    bytes,
    expiresAt: Date.now() + OBSERVER_INGRESS_CACHE_TTL_MS,
  });
  observerBatchIdDigestBytes += bytes;
  while (
    observerBatchIdDigests.size > OBSERVER_BATCH_ID_DIGEST_CACHE_SIZE
    || observerBatchIdDigestBytes > OBSERVER_BATCH_ID_DIGEST_CACHE_BYTES
  ) {
    const oldest = observerBatchIdDigests.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const entry = observerBatchIdDigests.get(oldest);
    observerBatchIdDigests.delete(oldest);
    observerBatchIdDigestBytes = Math.max(0, observerBatchIdDigestBytes - (entry?.bytes ?? 0));
    observerBatchIdDigestEvicted += 1;
  }
}

function cachedObserverBatchResult(batchKey: string, digest: string): T.ObserverBatchIngestResult | undefined {
  purgeIngressCaches();
  const cached = observerBatchResults.get(batchKey);
  if (!cached || cached.digest !== digest) return undefined;
  observerBatchResults.delete(batchKey);
  observerBatchResults.set(batchKey, cached);
  return structuredClone(cached.result);
}

function rememberObserverBatchResult(
  batchKey: string,
  digest: string,
  result: T.ObserverBatchIngestResult,
): void {
  purgeIngressCaches();
  const copy = structuredClone(result);
  const bytes = Buffer.byteLength(JSON.stringify(copy), 'utf8');
  if (bytes > OBSERVER_BATCH_RESULT_CACHE_BYTES) return;
  const previous = observerBatchResults.get(batchKey);
  if (previous) {
    observerBatchResultBytes = Math.max(0, observerBatchResultBytes - previous.bytes);
    observerBatchResults.delete(batchKey);
  }
  observerBatchResults.set(batchKey, {
    digest,
    result: copy,
    bytes,
    expiresAt: Date.now() + OBSERVER_INGRESS_CACHE_TTL_MS,
  });
  observerBatchResultBytes += bytes;
  while (
    observerBatchResults.size > OBSERVER_BATCH_RESULT_CACHE_SIZE
    || observerBatchResultBytes > OBSERVER_BATCH_RESULT_CACHE_BYTES
  ) {
    const oldestKey = observerBatchResults.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldest = observerBatchResults.get(oldestKey);
    if (oldest) observerBatchResultBytes = Math.max(0, observerBatchResultBytes - oldest.bytes);
    observerBatchResults.delete(oldestKey);
    observerBatchResultEvicted += 1;
  }
}

function universalEventReplay(
  key: string,
  digest: string,
): { item?: T.UniversalIngestResultItem; conflict: boolean } | undefined {
  purgeIngressCaches();
  const existing = universalEventIdempotency.get(key);
  if (!existing) return undefined;
  universalEventIdempotency.delete(key);
  universalEventIdempotency.set(key, existing);
  return existing.digest === digest
    ? { item: structuredClone(existing.item), conflict: false }
    : { conflict: true };
}

function rememberUniversalEvent(
  key: string,
  digest: string,
  item: T.UniversalIngestResultItem,
): void {
  purgeIngressCaches();
  const previous = universalEventIdempotency.get(key);
  if (previous) {
    universalEventIdempotency.delete(key);
    universalEventIdempotencyBytes = Math.max(0, universalEventIdempotencyBytes - previous.bytes);
  }
  const copy = structuredClone(item);
  const bytes = Buffer.byteLength(key, 'utf8') + Buffer.byteLength(digest, 'utf8')
    + Buffer.byteLength(JSON.stringify(copy), 'utf8') + 64;
  universalEventIdempotency.set(key, {
    digest,
    item: copy,
    bytes,
    expiresAt: Date.now() + OBSERVER_INGRESS_CACHE_TTL_MS,
  });
  universalEventIdempotencyBytes += bytes;
  while (universalEventIdempotency.size > UNIVERSAL_EVENT_IDEMPOTENCY_CACHE_SIZE) {
    const oldest = universalEventIdempotency.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const entry = universalEventIdempotency.get(oldest);
    universalEventIdempotency.delete(oldest);
    universalEventIdempotencyBytes = Math.max(0, universalEventIdempotencyBytes - (entry?.bytes ?? 0));
    universalEventIdempotencyEvicted += 1;
  }
  while (universalEventIdempotencyBytes > 8 * 1024 * 1024 && universalEventIdempotency.size > 0) {
    const oldest = universalEventIdempotency.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const entry = universalEventIdempotency.get(oldest);
    universalEventIdempotency.delete(oldest);
    universalEventIdempotencyBytes = Math.max(0, universalEventIdempotencyBytes - (entry?.bytes ?? 0));
    universalEventIdempotencyEvicted += 1;
  }
}

function reserveUniversalEvent(key: string, digest: string, index: number): void {
  rememberUniversalEvent(key, digest, {
    index,
    accepted: false,
    disposition: 'retryable',
    reasonCode: 'producer_event_in_flight',
    reason: 'producer event is already being durably committed',
  });
}

function forgetUniversalEventReservation(key: string, digest: string): void {
  const current = universalEventIdempotency.get(key);
  if (
    current?.digest === digest
    && current.item.accepted === false
    && current.item.reasonCode === 'producer_event_in_flight'
  ) {
    universalEventIdempotency.delete(key);
    universalEventIdempotencyBytes = Math.max(0, universalEventIdempotencyBytes - current.bytes);
  }
}

function clearIngressCaches(): void {
  observerBatchIdDigests.clear();
  observerBatchResults.clear();
  universalEventIdempotency.clear();
  observerBatchIdDigestBytes = 0;
  observerBatchResultBytes = 0;
  universalEventIdempotencyBytes = 0;
}

function ingressCacheStats(): Record<string, unknown> {
  purgeIngressCaches();
  return {
    ttlMs: OBSERVER_INGRESS_CACHE_TTL_MS,
    observerBatchIdDigests: {
      entries: observerBatchIdDigests.size,
      bytes: observerBatchIdDigestBytes,
      maxEntries: OBSERVER_BATCH_ID_DIGEST_CACHE_SIZE,
      maxBytes: OBSERVER_BATCH_ID_DIGEST_CACHE_BYTES,
      evicted: observerBatchIdDigestEvicted,
      expired: observerBatchIdDigestExpired,
    },
    observerBatchResults: {
      entries: observerBatchResults.size,
      bytes: observerBatchResultBytes,
      maxEntries: OBSERVER_BATCH_RESULT_CACHE_SIZE,
      maxBytes: OBSERVER_BATCH_RESULT_CACHE_BYTES,
      evicted: observerBatchResultEvicted,
      expired: observerBatchResultExpired,
    },
    universalEventIdempotency: {
      entries: universalEventIdempotency.size,
      bytes: universalEventIdempotencyBytes,
      maxEntries: UNIVERSAL_EVENT_IDEMPOTENCY_CACHE_SIZE,
      maxBytes: 8 * 1024 * 1024,
      evicted: universalEventIdempotencyEvicted,
      expired: universalEventIdempotencyExpired,
    },
  };
}

function universalAcceptedResultItem(
  index: number,
  event: T.JudgedEvent,
  duplicate = false,
): T.UniversalIngestResultItem {
  return {
    index,
    accepted: true,
    ...(duplicate ? { duplicate: true } : {}),
    disposition: 'retained',
    eventId: event.eventId,
    traceId: event.traceId,
    invocationId: event.invocationId,
    toolCallId: event.toolCallId,
    spanId: event.spanId,
    runId: event.runId,
    verdict: event.verdict,
    tier: event.tier,
    severity: event.severity,
    riskCategory: event.riskCategory,
    decisionStatus: event.decisionStatus,
    evaluationId: event.evaluationId,
  };
}

type PreparedRetainedJudgeAccept = Extract<PreparedJudgeAcceptOutcome, { disposition: 'retained' }>;
type PreparedStructuralJudgeAccept = Extract<PreparedJudgeAcceptOutcome, { disposition: 'structural_consumed' }>;

interface PreparedObserverBatchEvent {
  index: number;
  body: IngestBody;
  line: string;
  collectorId?: string;
  requestSourceId?: string;
  sourceName?: string;
  sourceType?: T.IngestionSourceType;
  nodeName?: string;
  sourceResolution: IngestionSourceResolution;
  meta: T.EventMeta;
  prepared: PreparedJudgeAcceptOutcome;
  interaction?: T.AgentInteractionRecord;
}

interface RejectedIngestContext {
  sourceId?: string;
  sourceName?: string;
  sourceType?: T.IngestionSourceType;
  collectorId?: string;
  workspacePath?: string;
  nodeName?: string;
  endpoint?: string;
  rejectedEvents?: number;
}

// Cluster LLM endpoints (agents call these for inference — internal/self-hosted, so they don't
// match the observer's public-provider SNI list, and several are plain HTTP). Egress/Dns to them is
// surfaced as an LlmCall so the dashboard observes LLM activity. Override via ANYSENTRY_LLM_ENDPOINTS.
const LLM_ENDPOINTS = (process.env.ANYSENTRY_LLM_ENDPOINTS ?? 'api.anthropic.com,api.openai.com,api.deepseek.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const OBSERVER_BATCH_CONCURRENCY = Math.max(
  1,
  Math.min(64, Number.parseInt(process.env.ANYSENTRY_OBSERVER_BATCH_CONCURRENCY ?? '24', 10) || 24),
);
let universalCanonicalSequence = 0;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(items.length, Math.max(1, concurrency)) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await work(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function canonicalSemanticRecordsForInteraction(
  interaction: T.AgentInteractionRecord,
  authority: SemanticRecord['authority'] = 'inferred',
): SemanticRecord[] {
  const sourceRefs = [...new Set([
    interaction.rawObservationId,
    ...(interaction.sourceObservationIds ?? []),
    interaction.interactionId,
  ].filter((value): value is string => Boolean(value)))].slice(0, 128);
  const derivedFrom = [...new Set([
    interaction.rawObservationId,
    interaction.interactionId,
  ].filter((value): value is string => Boolean(value)))];
  const completeness: SemanticRecord['completeness'] = interaction.completeness === 'complete'
    ? 'complete'
    : interaction.completeness === 'unsupported' ? 'unsupported'
      : interaction.interactionType === 'unparsed' ? 'unparsed' : 'partial';
  const records: SemanticRecord[] = [];
  const semanticRevision = boundedCanonicalRevision(
    interaction.semanticParserVersion ?? interaction.sessionResolutionRevision,
  );
  const id = (kind: string, suffix: string) => `sr_${createHash('sha256').update([
    kind, interaction.interactionId, suffix,
  ].join('\0')).digest('hex').slice(0, 24)}`;
  const common = {
    revision: semanticRevision,
    resolutionRevision: boundedCanonicalRevision(interaction.sessionResolutionRevision),
    authority,
    sourceRefs,
    derivedFrom,
    parserId: interaction.semanticParserId ?? 'anysentry.agent-interaction',
    parserVersion: String(interaction.semanticParserVersion ?? 1),
    ...(interaction.logicalAgentId ? { logicalAgentId: interaction.logicalAgentId } : {}),
    ...(interaction.canonicalAgentInstanceId
      ? { agentInstanceId: interaction.canonicalAgentInstanceId }
      : {}),
    ...(interaction.runtimeInstanceId ?? interaction.agentInstanceId
      ? { runtimeInstanceId: interaction.runtimeInstanceId ?? interaction.agentInstanceId }
      : {}),
    ...(interaction.sessionId ? { sessionId: interaction.sessionId } : {}),
    ...(interaction.canonicalSessionId ? { canonicalSessionId: interaction.canonicalSessionId } : {}),
    ...(interaction.sessionNamespaceKey ? { sessionNamespaceKey: interaction.sessionNamespaceKey } : {}),
    ...(interaction.sessionKey ? { sessionKey: interaction.sessionKey } : {}),
    ...(interaction.providerSessionIdHash ? { providerSessionIdHash: interaction.providerSessionIdHash } : {}),
    ...(interaction.turnId ? { turnId: interaction.turnId } : {}),
    ...(interaction.runId ? { runId: interaction.runId } : {}),
    ...(interaction.sessionMode ? { sessionMode: interaction.sessionMode } : {}),
    ...(interaction.sessionLifecycle ? { sessionLifecycle: interaction.sessionLifecycle } : {}),
    ...(interaction.parentSessionId || interaction.canonicalParentSessionId
      ? {
          parentSessionId: interaction.canonicalParentSessionId
            ?? canonicalParentSessionIdForMembership(
              interaction.parentSessionId,
              interaction.sessionNamespaceKey,
            ),
          canonicalParentSessionId: interaction.canonicalParentSessionId
            ?? canonicalParentSessionIdForMembership(
              interaction.parentSessionId,
              interaction.sessionNamespaceKey,
            ),
        }
      : {}),
    ...(interaction.tenantId ? { tenantId: interaction.tenantId } : {}),
    ...(interaction.ownerId ? { ownerId: interaction.ownerId } : {}),
    ...(interaction.logicalDefinitionFingerprint ? { logicalDefinitionFingerprint: interaction.logicalDefinitionFingerprint } : {}),
    ...(interaction.logicalScopeMode ? { logicalScopeMode: interaction.logicalScopeMode } : {}),
    ...(interaction.logicalIdentityAuthority ? { logicalIdentityAuthority: interaction.logicalIdentityAuthority } : {}),
    ...(interaction.profile ? { profile: interaction.profile } : {}),
    ...(interaction.profileVersion ? { profileVersion: interaction.profileVersion } : {}),
    ...(interaction.deploymentId ? { deploymentId: interaction.deploymentId } : {}),
    ...(interaction.deploymentRevision ? { deploymentRevision: interaction.deploymentRevision } : {}),
    ...(interaction.environmentId ? { environmentId: interaction.environmentId } : {}),
    ...(interaction.terminalContextId ? { terminalContextId: interaction.terminalContextId } : {}),
    completeness,
    partialReasons: interaction.partialReasons.slice(0, 64),
  };
  if (interaction.interactionType === 'model') {
    records.push({
      schemaVersion: 'anysentry.semantic_record.v1',
      semanticRecordId: id('llm_call', 'call'),
      kind: 'llm_call',
      observedAtUnixNs: interaction.startedAtUnixNs,
      payloadRef: `sha256:${interaction.request.sha256}:${interaction.response.sha256}`,
      ...common,
    });
  } else if (interaction.interactionType === 'unparsed') {
    records.push({
      schemaVersion: 'anysentry.semantic_record.v1',
      semanticRecordId: id('runtime_activity', 'unparsed'),
      kind: 'runtime_activity',
      observedAtUnixNs: interaction.startedAtUnixNs,
      payloadRef: `sha256:${interaction.request.sha256}:${interaction.response.sha256}`,
      ...common,
    });
  }
  const messages = [
    ...(interaction.request.messages ?? []),
    ...(interaction.response.messages ?? []),
  ].slice(0, 512);
  messages.forEach((message, index) => {
    const role = message.role.toLowerCase();
    const canonicalRole: SemanticRecord['role'] = role === 'assistant' || role === 'model'
      ? 'model' : role === 'tool' || role === 'function' ? 'tool'
        : role === 'system' || role === 'developer' ? 'system' : 'user';
    records.push({
      schemaVersion: 'anysentry.semantic_record.v1',
      semanticRecordId: id('message', String(index)),
      kind: 'message',
      role: canonicalRole,
      observedAtUnixNs: interaction.startedAtUnixNs,
      payloadRef: `sha256:${createHash('sha256').update(JSON.stringify(message.content)).digest('hex')}`,
      ...common,
    });
  });
  interaction.toolCalls.slice(0, 256).forEach((call, index) => {
    records.push({
      schemaVersion: 'anysentry.semantic_record.v1',
      semanticRecordId: id('tool_call', `${call.toolCallId}:${index}`),
      kind: 'tool_call',
      role: 'model',
      toolCallId: call.toolCallId,
      observedAtUnixNs: call.issuedAtUnixNs ?? interaction.startedAtUnixNs,
      payloadRef: `sha256:${createHash('sha256').update(JSON.stringify(call.arguments)).digest('hex')}`,
      ...common,
    });
  });
  interaction.toolResults.slice(0, 256).forEach((result, index) => {
    records.push({
      schemaVersion: 'anysentry.semantic_record.v1',
      semanticRecordId: id('tool_result', `${result.toolCallId}:${index}`),
      kind: 'tool_result',
      role: 'tool',
      toolCallId: result.toolCallId,
      observedAtUnixNs: result.observedAtUnixNs ?? interaction.endedAtUnixNs,
      payloadRef: `sha256:${createHash('sha256').update(JSON.stringify(result.content)).digest('hex')}`,
      ...common,
    });
  });
  return records;
}

function semanticToolHints(event: T.JudgedEvent): {
  toolCallId?: string;
  toolName?: string;
  endpoint?: string;
  completed: boolean;
  isError: boolean;
  resultHash?: string;
  exitCode?: number;
  endedAtUnixNs?: string;
} {
  const attributes = event.attributes ?? {};
  const toolCallId = event.toolCallId
    ?? attrText(attributes, 'anysentry.tool.call.id', 'gen_ai.tool.call.id', 'tool_call.id', 'tool.id');
  const toolName = cleanString(attrText(
    attributes,
    'anysentry.tool.name',
    'gen_ai.tool.name',
    'tool.name',
    'toolName',
    'name',
  ), 120);
  const rawEndpoint = attrText(
    attributes,
    'anysentry.endpoint',
    'gen_ai.tool.endpoint',
    'tool.endpoint',
    'server.address',
    'net.peer.name',
    'network.peer.address',
    'peer.service',
    'url.full',
    'http.url',
    'rpc.service',
  );
  const explicitPort = attrNumber(
    attributes,
    'anysentry.tool.port',
    'server.port',
    'net.peer.port',
    'network.peer.port',
    'destination.port',
  );
  let endpoint: string | undefined;
  if (rawEndpoint || explicitPort !== undefined) {
    const boundedPort = explicitPort !== undefined
      && Number.isSafeInteger(explicitPort)
      && explicitPort > 0
      && explicitPort <= 65_535
      ? String(Math.trunc(explicitPort))
      : '';
    try {
      const candidate = rawEndpoint
        ? rawEndpoint.includes('://') ? rawEndpoint : `http://${rawEndpoint}`
        : `http://unknown${boundedPort ? `:${boundedPort}` : ''}`;
      const parsed = new URL(candidate);
      const host = parsed.hostname.trim();
      if (host) {
        const port = parsed.port || boundedPort;
        const pathname = parsed.pathname && parsed.pathname !== '/'
          ? parsed.pathname.slice(0, 240)
          : '';
        const protocol = parsed.protocol === 'https:' ? 'https' : 'http';
        endpoint = `${protocol}://${host}${port ? `:${port}` : ''}${pathname}`;
      }
    } catch {
      // Keep an opaque service/host hint only; never carry userinfo, query or fragment into the
      // canonical interaction where it could expose a token or unbounded producer payload.
      const opaque = rawEndpoint
        ?.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '')
        .split(/[?#]/u)[0]
        .replace(/^[^/@]+@/u, '')
        .replace(/[\s"'`,;]/gu, '')
        .slice(0, 240);
      if (opaque) endpoint = `http://${opaque}${boundedPort && !/:\d{1,5}$/u.test(opaque) ? `:${boundedPort}` : ''}`;
    }
  }
  const exitCode = attrNumber(attributes, 'anysentry.tool.exit_code', 'tool.exit_code', 'process.exit_code', 'exit_code');
  const resultHashValue = attrText(attributes, 'anysentry.tool.result_hash', 'tool.result_hash', 'gen_ai.tool.result_hash');
  const resultHash = resultHashValue && /^[a-f0-9]{64}$/iu.test(resultHashValue)
    ? resultHashValue.toLowerCase()
    : undefined;
  const status = attrText(attributes, 'anysentry.tool.status', 'tool.status', 'status', 'otel.status_code', 'status.code');
  const lifecyclePhase = attrText(attributes, 'anysentry.lifecycle.phase', 'lifecycle.phase', 'span.lifecycle.phase');
  const rawSpanEnd = attrNumber(attributes, 'anysentry.span.end_at_ms', 'span.end_at_ms');
  // Adapter timestamps are hints, not an authority to create an unbounded open interval.  Accept
  // an end only when it follows the observed start and remains inside the same bounded day.
  const spanEnd = rawSpanEnd !== undefined
    && rawSpanEnd >= event.at
    && rawSpanEnd <= event.at + 24 * 60 * 60_000
    ? rawSpanEnd
    : undefined;
  const endedAtMs = spanEnd
    ?? (event.latencyMs > 0 && event.latencyMs <= 24 * 60 * 60_000
      ? event.at + event.latencyMs : undefined);
  const explicitError = attributes['anysentry.tool.is_error'] === true
    || attributes['tool.is_error'] === true
    || (typeof attributes['error.type'] === 'string' && Boolean(attributes['error.type']))
    || (typeof attributes['error.message'] === 'string' && Boolean(attributes['error.message']))
    || (typeof status === 'string' && /(?:error|fail)/iu.test(status));
  const completed = exitCode !== undefined
    || resultHash !== undefined
    || spanEnd !== undefined
    || /^(?:end|complete|completed|finished)$/iu.test(lifecyclePhase ?? '')
    || (typeof status === 'string' && /^(?:ok|success|completed?|finished?|error|failed?)$/iu.test(status));
  return {
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(endpoint ? { endpoint } : {}),
    completed,
    isError: explicitError || (exitCode !== undefined && exitCode !== 0),
    ...(resultHash ? { resultHash } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(endedAtMs !== undefined && Number.isFinite(endedAtMs) && endedAtMs >= 0
      ? { endedAtUnixNs: String(BigInt(Math.trunc(endedAtMs)) * 1_000_000n) }
      : {}),
  };
}

function semanticToolResultMarker(
  payloadRef: string,
  hints: ReturnType<typeof semanticToolHints>,
): Record<string, unknown> {
  return {
    schemaVersion: 'anysentry.semantic_reference.v1',
    payloadRef,
    contentState: 'reference_only',
    ...(hints.resultHash ? { resultHash: hints.resultHash } : {}),
    ...(hints.exitCode !== undefined ? { exitCode: hints.exitCode } : {}),
    ...(hints.isError ? { isError: true } : {}),
  };
}

function semanticTrafficRole(
  event: T.JudgedEvent,
  normalizedKind: string,
  hasHumanOrToolContent: boolean,
): NonNullable<T.AgentInteractionRecord['trafficRole']> {
  const explicit = attrText(
    event.attributes ?? {},
    'anysentry.traffic.role',
    'traffic.role',
    'agent.traffic.role',
  )?.toLowerCase();
  const roles = new Set<NonNullable<T.AgentInteractionRecord['trafficRole']>>([
    'conversation', 'bootstrap', 'control', 'context_replay', 'tool_backend',
    'derived_metadata', 'retry', 'background', 'unclassified',
  ]);
  if (explicit && roles.has(explicit as NonNullable<T.AgentInteractionRecord['trafficRole']>)) {
    return explicit as NonNullable<T.AgentInteractionRecord['trafficRole']>;
  }
  const operation = attrText(
    event.attributes ?? {},
    'gen_ai.operation.name',
    'rpc.method',
    'http.route',
    'operation.name',
  )?.toLowerCase() ?? '';
  if (/(?:^|[/:.])initialize$|tools?\/list|list_tools|bootstrap|capabilit(?:y|ies)/iu.test(operation)) {
    return /bootstrap/iu.test(operation) ? 'bootstrap' : 'control';
  }
  if (/(?:initialize|tools?\/list|list_tools|bootstrap|capabilit(?:y|ies))/iu.test(normalizedKind)) {
    return /bootstrap/iu.test(normalizedKind) ? 'bootstrap' : 'control';
  }
  if (hasHumanOrToolContent) return 'conversation';
  if (['agentinvocation', 'noderun', 'workflow_node', 'workflownode', 'node_run'].includes(normalizedKind)) {
    return 'background';
  }
  // A model/API span with a trusted run/session anchor can still be part of the human-visible
  // turn; an anchor-free infrastructure span is safer as technical activity than as a new thread.
  if (['llmapi', 'llmcall', 'llminteraction', 'llm_response', 'llmresponse'].includes(normalizedKind)
    && (event.runId || event.turnId || event.sessionId || event.canonicalSessionId)) {
    return 'conversation';
  }
  return 'background';
}

function canonicalSemanticRecordForEvent(
  event: T.JudgedEvent,
  authority: SemanticRecord['authority'],
): SemanticRecord[] {
  const sourceRefs = [...new Set([
    event.rawObservationId,
    event.eventId,
    event.sourceEventId,
  ].filter((value): value is string => Boolean(value)))].slice(0, 128);
  const derivedFrom = [...new Set([
    event.rawObservationId,
    event.eventId,
  ].filter((value): value is string => Boolean(value)))];
  const normalizedKind = event.eventKind.trim().toLowerCase().replace(/[\s.-]+/gu, '_');
  const toolHints = semanticToolHints(event);
  const semanticToolCallId = toolHints.toolCallId;
  const kind: SemanticRecord['kind'] = event.eventKind === 'AgentTool'
    || ['tool', 'tool_call', 'toolcall', 'function_call', 'functioncall'].includes(normalizedKind)
    ? 'tool_call'
    : event.eventKind === 'AgentInvocation'
      || ['node', 'node_run', 'noderun', 'workflow_run', 'workflowrun', 'agent_run', 'agentrun'].includes(normalizedKind)
      ? 'node_run'
      : event.eventKind === 'LlmCall' || event.eventKind === 'LlmApi' || event.eventKind === 'LlmInteraction'
        || ['llm', 'llm_call', 'llmcall', 'llm_response', 'llmresponse', 'model_response', 'modelresponse'].includes(normalizedKind)
        ? 'llm_call'
    : ['tool_result', 'toolresult', 'function_result', 'functionresult', 'agent_tool_result', 'agenttoolresult', 'node_result', 'noderesult'].includes(normalizedKind)
      ? 'tool_result'
      : ['user_message', 'usermessage', 'user_input', 'human_message', 'input_message'].includes(normalizedKind)
        ? 'message'
        : ['model_message', 'modelmessage', 'assistant_message', 'assistantmessage', 'assistant_output', 'final_response'].includes(normalizedKind)
              ? 'message'
              : 'runtime_activity';
  const role: SemanticRecord['role'] = kind === 'tool_call' || kind === 'node_run'
    ? 'model'
    : kind === 'tool_result' ? 'tool'
      : ['user_message', 'usermessage', 'user_input', 'human_message', 'input_message'].includes(normalizedKind)
        ? 'user'
        : ['model_message', 'modelmessage', 'assistant_message', 'assistantmessage', 'assistant_output', 'final_response'].includes(normalizedKind)
          ? 'model' : undefined;
  const observedAtUnixNs = event.eventAtUnixNs ?? String(BigInt(Math.max(1, event.at)) * 1_000_000n);
  const adapterRevision = Number(event.attributes?.semanticParserVersion
    ?? event.attributes?.['semantic.parser.version']);
  const semanticRevision = boundedCanonicalRevision(
    Number.isFinite(adapterRevision)
      ? adapterRevision
      : event.sessionResolutionRevision ?? event.identityRevision,
  );
  const payloadHash = createHash('sha256').update(JSON.stringify({
    kind: event.eventKind,
    subject: event.subject,
    attributes: event.attributes,
  })).digest('hex');
  const baseRecord: SemanticRecord = {
    schemaVersion: 'anysentry.semantic_record.v1',
    semanticRecordId: `sr_${createHash('sha256').update(`${event.eventId}\0${kind}`).digest('hex').slice(0, 24)}`,
    revision: semanticRevision,
    resolutionRevision: boundedCanonicalRevision(event.sessionResolutionRevision),
    kind,
    authority,
    sourceRefs,
    derivedFrom,
    observedAtUnixNs,
    ...(event.logicalAgentId ? { logicalAgentId: event.logicalAgentId } : {}),
    ...(event.canonicalAgentInstanceId ? { agentInstanceId: event.canonicalAgentInstanceId } : {}),
    ...(event.runtimeInstanceId ?? event.attribution?.agentInstanceId
      ? { runtimeInstanceId: event.runtimeInstanceId ?? event.attribution?.agentInstanceId }
      : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.canonicalSessionId ? { canonicalSessionId: event.canonicalSessionId } : {}),
    ...(event.sessionNamespaceKey ? { sessionNamespaceKey: event.sessionNamespaceKey } : {}),
    ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
    ...(event.providerSessionIdHash ? { providerSessionIdHash: event.providerSessionIdHash } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.sessionMode ? { sessionMode: event.sessionMode } : {}),
    ...(event.sessionLifecycle ? { sessionLifecycle: event.sessionLifecycle } : {}),
    ...(event.parentSessionId || event.canonicalParentSessionId
      ? {
          parentSessionId: event.canonicalParentSessionId
            ?? canonicalParentSessionIdForMembership(
              event.parentSessionId,
              event.sessionNamespaceKey,
            ),
          canonicalParentSessionId: event.canonicalParentSessionId
            ?? canonicalParentSessionIdForMembership(
              event.parentSessionId,
              event.sessionNamespaceKey,
            ),
        }
      : {}),
    ...(semanticToolCallId ? { toolCallId: semanticToolCallId } : {}),
    ...(event.tenantId ? { tenantId: event.tenantId } : {}),
    ...(event.ownerId ? { ownerId: event.ownerId } : {}),
    ...(event.logicalDefinitionFingerprint ? { logicalDefinitionFingerprint: event.logicalDefinitionFingerprint } : {}),
    ...(event.logicalScopeMode ? { logicalScopeMode: event.logicalScopeMode } : {}),
    ...(event.logicalIdentityAuthority ? { logicalIdentityAuthority: event.logicalIdentityAuthority } : {}),
    ...(event.profile ? { profile: event.profile } : {}),
    ...(event.profileVersion ? { profileVersion: event.profileVersion } : {}),
    ...(event.deploymentId ? { deploymentId: event.deploymentId } : {}),
    ...(event.deploymentRevision ? { deploymentRevision: event.deploymentRevision } : {}),
    ...(event.environmentId ? { environmentId: event.environmentId } : {}),
    ...(event.terminalContextId ? { terminalContextId: event.terminalContextId } : {}),
    ...(role ? { role } : {}),
    // The RawObservation may be complete while this compatibility record intentionally carries
    // only reference markers. Keep semantic completeness independent from raw commit status.
    completeness: 'partial',
    partialReasons: [
      'application_semantic_reference_only',
      ...(event.rawObservationId ? [] : ['raw_observation_missing']),
    ],
    payloadRef: `sha256:${payloadHash}`,
  };
  if (kind !== 'tool_call' || !semanticToolCallId || !toolHints.completed) return [baseRecord];
  // A completed OTLP execute_tool span carries no second log record.  Add a reference-only
  // ToolResult projection from its explicit result hash/exit status so the human lane can close
  // the call without copying tool output or claiming that a KernelFact was observed.
  const resultPayloadRef = toolHints.resultHash
    ? `sha256:${toolHints.resultHash}`
    : baseRecord.payloadRef;
  const resultRecord: SemanticRecord = {
    ...baseRecord,
    semanticRecordId: `sr_${createHash('sha256').update(`${event.eventId}\0tool_result`).digest('hex').slice(0, 24)}`,
    kind: 'tool_result',
    role: 'tool',
    observedAtUnixNs: toolHints.endedAtUnixNs ?? baseRecord.observedAtUnixNs,
    payloadRef: resultPayloadRef,
    completeness: 'partial',
    partialReasons: ['application_semantic_reference_only'],
  };
  return [baseRecord, resultRecord];
}

/**
 * Compatibility projection for authenticated application/OTLP semantic events.  It carries only
 * hash/reference content (never a copied prompt/body) so the existing Conversation/Turn/Run read
 * model can consume the canonical semantic lane while the immutable JudgedEvent remains the fact
 * of record.
 */
function canonicalInteractionForSemanticEvent(event: T.JudgedEvent): T.AgentInteractionRecord {
  const normalizedKind = event.eventKind.trim().toLowerCase().replace(/[\s.-]+/gu, '_');
  const atUnixNs = event.eventAtUnixNs
    ?? (BigInt(Math.max(1, Math.trunc(event.at))) * 1_000_000n).toString();
  const payloadDigest = createHash('sha256').update(JSON.stringify({
    eventId: event.eventId,
    eventKind: event.eventKind,
    subject: event.subject,
    attributes: event.attributes,
  })).digest('hex');
  const payloadRef = `sha256:${payloadDigest}`;
  const contentMarker = {
    schemaVersion: 'anysentry.semantic_reference.v1',
    payloadRef,
    contentState: 'reference_only',
  };
  const userMessage = normalizedKind === 'usermessage' || normalizedKind === 'user_message';
  const modelMessage = ['modelmessage', 'model_message', 'llmresponse', 'llm_response', 'llmcall', 'llm_call']
    .includes(normalizedKind);
  const toolCallEvent = normalizedKind === 'agenttool' || normalizedKind === 'agent_tool'
    || normalizedKind === 'toolcall' || normalizedKind === 'tool_call';
  const toolResultEvent = normalizedKind === 'toolresult' || normalizedKind === 'tool_result';
  const toolHints = semanticToolHints(event);
  const toolCallId = toolHints.toolCallId
    ?? (toolCallEvent || toolResultEvent
      ? `tc_${createHash('sha256').update(event.eventId).digest('hex').slice(0, 24)}`
      : undefined);
  const toolName = toolHints.toolName ?? 'application_tool';
  const semanticEndpoint = toolHints.endpoint;
  const completedToolEvent = toolCallEvent && toolHints.completed;
  const projectedToolResult = toolResultEvent || completedToolEvent;
  const toolResultAtUnixNs = toolHints.endedAtUnixNs ?? atUnixNs;
  const semanticDurationNs = completedToolEvent
    ? (() => {
        try {
          const duration = BigInt(toolResultAtUnixNs) - BigInt(atUnixNs);
          return duration > 0n ? duration.toString() : '0';
        } catch {
          return '0';
        }
      })()
    : '0';
  const turnId = event.turnId ?? event.runId;
  const message: T.AgentInteractionMessage | undefined = userMessage
    ? {
        role: 'user',
        content: contentMarker,
        sourceItemId: event.eventId,
        turnId,
        messageOrigin: 'human_input',
      }
    : modelMessage
      ? {
          role: 'assistant',
          content: contentMarker,
          sourceItemId: event.eventId,
          turnId,
        }
      : toolResultEvent && toolCallId
        ? {
            role: 'tool',
            content: contentMarker,
            toolCallId,
            sourceItemId: event.eventId,
            turnId,
            messageOrigin: 'tool_history',
          }
        : undefined;
  const emptySha = createHash('sha256').update('').digest('hex');
  const interactionContent = (messages: T.AgentInteractionMessage[]): T.AgentInteractionContent => ({
    body: '',
    encoding: 'utf8',
    contentType: 'application/vnd.anysentry.semantic-reference+json',
    capturedBytes: 0,
    decodedBytes: 0,
    sha256: emptySha,
    completeness: 'reference_only',
    ...(messages.length ? { messages } : {}),
    structured: contentMarker,
  });
  const requestMessages = userMessage && message ? [message] : [];
  const responseMessages = !userMessage && message ? [message] : [];
  const canonicalSessionId = event.canonicalSessionId
    ?? canonicalSessionIdForMembership(
      event.sessionId ?? event.sessionKey ?? event.eventId,
      event.sessionNamespaceKey,
      event.eventId,
    );
  const conversationId = `cv_${createHash('sha256')
    .update(`application-semantic\0${canonicalSessionId}`)
    .digest('hex')
    .slice(0, 24)}`;
  const runtimeInstanceId = event.runtimeInstanceId ?? event.attribution?.agentInstanceId;
  const agentAssetId = event.subjectAssetId
    ?? `agent_${createHash('sha256').update([
      event.logicalAgentId,
      event.agentId,
      event.workspacePath,
    ].map((value) => value ?? '').join('\0')).digest('hex').slice(0, 24)}`;
  const environment = event.attribution?.workloadRef?.environment;
  const detectedClassification = event.attribution?.classification === 'confirmed_agent'
    || event.attribution?.classification === 'probable_agent'
    ? event.attribution.classification
    : event.logicalAgentId && event.logicalIdentityAuthority === 'management_registration'
      ? 'probable_agent'
      : 'unknown';
  const semanticActor: T.AgentInteractionSemanticActor = userMessage
    ? 'user' : toolCallEvent || toolResultEvent ? 'tool' : 'model';
  const semanticKind: T.AgentInteractionSemanticKind = userMessage
    ? 'user_message'
    : toolCallEvent ? 'tool_call'
      : toolResultEvent ? 'tool_result'
        : modelMessage ? 'model_final' : 'model_progress';
  const trafficRole = semanticTrafficRole(
    event,
    normalizedKind,
    userMessage || toolCallEvent || toolResultEvent,
  );
  return {
    schemaVersion: 'anysentry.agent_interaction.v1',
    interactionId: `mi_${createHash('sha256').update(`application-semantic\0${event.eventId}`).digest('hex').slice(0, 24)}`,
    // Keep semantic tool spans in the model interaction lane for legacy timeline compatibility;
    // the relation matcher separately recognizes `semanticOnly` records carrying ToolCall data.
    interactionType: 'model',
    semanticOnly: true,
    at: event.at,
    tenantId: event.tenantId,
    ownerId: event.ownerId,
    environmentId: event.environmentId,
    profile: event.profile,
    profileVersion: event.profileVersion,
    deploymentId: event.deploymentId,
    deploymentRevision: event.deploymentRevision,
    workspacePath: event.workspacePath,
    sourceId: event.sourceId,
    collectorId: event.collectorId,
    agentAssetId,
    agentInstanceId: runtimeInstanceId,
    canonicalAgentInstanceId: event.canonicalAgentInstanceId,
    runtimeInstanceId,
    agentProduct: event.agentId,
    environment: environment === 'host' || environment === 'docker' || environment === 'kubernetes'
      ? environment : 'unknown',
    rawObservationId: event.rawObservationId,
    sourceObservationIds: [event.rawObservationId, event.eventId]
      .filter((value): value is string => Boolean(value)),
    kernelFactId: event.kernelFactId,
    logicalAgentId: event.logicalAgentId,
    logicalAgentCandidateId: event.logicalAgentCandidateId,
    logicalDefinitionId: event.logicalDefinitionId,
    logicalScopeMode: event.logicalScopeMode,
    logicalIdentityAuthority: event.logicalIdentityAuthority,
    logicalDefinitionFingerprint: event.logicalDefinitionFingerprint,
    terminalContextId: event.terminalContextId,
    sessionIdentityQuality: event.sessionIdentityQuality,
    sessionIdSource: event.sessionIdSource,
    sessionMode: event.sessionMode,
    sessionLifecycle: event.sessionLifecycle,
    parentSessionId: event.parentSessionId,
    canonicalParentSessionId: event.canonicalParentSessionId,
    sessionResolutionRevision: event.sessionResolutionRevision,
    traceId: event.traceId,
    runId: event.runId,
    runIdSource: event.runIdSource,
    sessionId: event.sessionId,
    sessionKey: event.sessionKey,
    canonicalSessionId,
    sessionNamespaceKey: event.sessionNamespaceKey,
    providerSessionIdHash: event.providerSessionIdHash,
    invocationId: event.invocationId,
    providerConversationId: event.sessionIdSource === 'provider' ? event.sessionId : undefined,
    trafficRole,
    evidenceEventIds: [event.eventId],
    conversationId,
    conversationIdSource: event.sessionIdSource === 'provider' ? 'provider' : 'inferred',
    conversationBindingVersion: 1,
    turnId,
    runtimeRole: 'agent_root',
    correlationQuality: runtimeInstanceId ? 'strong' : 'inferred',
    detectedClassification,
    currentEffectiveClassification: detectedClassification,
    process: event.process,
    connectionId: typeof event.attributes.connectionId === 'string'
      ? event.attributes.connectionId : `application:${event.eventId}`,
    transport: 'http',
    protocol: 'application-semantic',
    transportProtocol: 'application-semantic',
    wireTemplateId: 'canonical-semantic-record',
    parseState: 'parsed',
    llmLikelihood: modelMessage ? 'likely' : 'unknown',
    transportCompleteness: 'partial',
    wireCompleteness: 'unknown',
    conversationCompleteness: 'partial',
    endpoint: semanticEndpoint ?? 'application://semantic-event',
    method: 'EVENT',
    path: `/${event.eventKind}`,
    statusCode: 200,
    model: typeof event.attributes.model === 'string' ? event.attributes.model : undefined,
    startedAtUnixNs: atUnixNs,
    requestCompleteAtUnixNs: atUnixNs,
    firstResponseAtUnixNs: atUnixNs,
    endedAtUnixNs: completedToolEvent ? toolResultAtUnixNs : atUnixNs,
    durationNs: semanticDurationNs,
    timeQuality: event.eventTimeQuality ?? 'api_received',
    request: interactionContent(requestMessages),
    response: interactionContent(responseMessages),
    toolCalls: toolCallEvent && toolCallId
      ? [{ toolCallId, name: toolName, arguments: contentMarker, issuedAtUnixNs: atUnixNs }]
      : [],
    toolResults: projectedToolResult && toolCallId
      ? [{
          toolCallId,
          name: toolName,
          content: completedToolEvent
            ? semanticToolResultMarker(
                toolHints.resultHash ? `sha256:${toolHints.resultHash}` : payloadRef,
                toolHints,
              )
            : contentMarker,
          isError: toolHints.isError,
          observedAtUnixNs: toolResultAtUnixNs,
        }]
      : [],
    semanticParserId: 'universal-semantic-projection',
    semanticParserVersion: boundedCanonicalRevision(event.sessionResolutionRevision),
    semanticItems: [{
      semanticItemId: `si_${createHash('sha256').update(event.eventId).digest('hex').slice(0, 24)}`,
      actor: semanticActor,
      kind: semanticKind,
      ...(semanticKind === 'model_final' ? { phase: 'final' as const } : {}),
      origin: userMessage ? 'request' : 'response',
      atUnixNs,
      content: contentMarker,
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolCallEvent || toolResultEvent ? { toolName } : {}),
      sourceItemId: event.eventId,
      turnId,
      completeness: 'partial',
      partialReasons: ['application_semantic_reference_only'],
    }, ...(completedToolEvent && toolCallId ? [{
      semanticItemId: `si_${createHash('sha256').update(`${event.eventId}\0tool_result`).digest('hex').slice(0, 24)}`,
      actor: 'tool' as const,
      kind: 'tool_result' as const,
      origin: 'response' as const,
      atUnixNs: toolResultAtUnixNs,
      content: semanticToolResultMarker(
        toolHints.resultHash ? `sha256:${toolHints.resultHash}` : payloadRef,
        toolHints,
      ),
      toolCallId,
      toolName,
      sourceItemId: event.eventId,
      turnId,
      completeness: 'partial' as const,
      partialReasons: ['application_semantic_reference_only'],
    }] : [])],
    completeness: 'reference_only',
    partialReasons: ['application_semantic_reference_only'],
    captureSource: 'authenticated_application_event',
    receivedAt: event.receivedAt ?? event.at,
  };
}

function isSemanticUniversalEventKind(kind: string): boolean {
  const normalizedKind = kind.trim().toLowerCase().replace(/[\s.-]+/gu, '_');
  return [
    'agenttool', 'agentinvocation', 'llmcall', 'llmapi', 'llminteraction', 'usermessage', 'modelmessage', 'toolresult', 'noderun', 'llmresponse',
    'tool', 'tool_call', 'toolcall', 'function_call', 'functioncall', 'tool_result', 'function_result',
    'agent_tool_result', 'node_result', 'node', 'node_run', 'workflow_node', 'workflownode', 'workflow_run', 'agent_run',
    'llm', 'llm_call', 'llm_response', 'model_response',
    'user_message', 'user_input', 'human_message', 'input_message',
    'model_message', 'assistant_message', 'assistant_output', 'final_response',
  ].includes(normalizedKind);
}

function canonicalEvidenceLinksForRelations(
  relations: readonly T.AgentSemanticKernelRelation[],
): EvidenceLink[] {
  return relations.map((relation) => {
    const kind = relation.kernelEventKind ?? '';
    const toType: EvidenceLink['toType'] = kind === 'FileAccess' || kind === 'FileDelete'
      ? 'file' : kind === 'Egress' || kind === 'Dns' || kind === 'Tls' ? 'network' : 'kernel_fact';
    const method: EvidenceLink['method'] = relation.linkMethod === 'command'
      ? 'command' : relation.linkMethod === 'resource' ? 'resource'
        : relation.linkMethod === 'network' || relation.linkMethod === 'network_endpoint' ? 'network'
          : relation.linkMethod === 'shell_bootstrap' ? 'process_generation' : 'none';
    const status: EvidenceLink['status'] = relation.status === 'linked_exact'
      ? 'confirmed' : relation.status === 'linked_strong' ? 'strong'
        : relation.status === 'ambiguous' ? 'ambiguous'
          : relation.status === 'coverage_gap' ? 'coverage_gap' : 'unmatched';
    return createEvidenceLink({
      fromType: 'tool_call',
      fromId: relation.toolInvocationId,
      toType,
      toId: relation.kernelFactId ?? relation.kernelEventId ?? `unmatched:${relation.stableSemanticEventId}`,
      relation: toType === 'file' ? 'file_effect' : toType === 'network' ? 'network_effect' : 'executes_as',
      method,
      confidence: status === 'confirmed' ? 1 : status === 'strong' ? relation.confidence : 0,
      authority: 'inferred',
      evidenceRefs: [...(relation.sourceRefs ?? []), relation.stableSemanticEventId],
      algorithmVersion: relation.algorithmVersion ?? `semantic-kernel-relation.v${relation.relationVersion}`,
      status,
      // Legacy relation rows may not carry a canonical timestamp. Keep the EvidenceLink valid
      // under the Unix-ns contract while exposing the relation's source refs/revision; this
      // synthetic epoch is never presented as measured event time.
      validFromUnixNs: relation.validFromUnixNs ?? '1000000000',
      resolutionRevision: relation.relationRevision ?? relation.resolutionRevision,
    });
  });
}

function canonicalSemanticAuthority(
  resolution: IngestionSourceResolution,
  collectorId: string | undefined,
  adapterEvent: boolean,
  meta?: T.EventMeta,
): SemanticRecord['authority'] {
  if (isTrustedCollectorProducer(resolution, collectorId)) return 'attested_observer';
  // `bindTrustedCorrelationForIngest` stores the result of the exact Source-policy check in a
  // server-only WeakMap.  The public IngestionSourceResolution is intentionally computed before
  // each event's raw scope is known (and therefore may report `claimAuthorization=false` for a
  // mixed batch).  Prefer the per-event capability when it is present; never infer authority from
  // a producer-supplied field alone.
  const trusted = meta ? serverTrustedCorrelationContext(meta)?.sourceTrust : undefined;
  if (trusted?.authenticated && trusted.allowedClaims.includes(adapterEvent ? 'agent_adapter' : 'application_trace')) {
    return adapterEvent ? 'authenticated_adapter' : 'server_graph';
  }
  // A present server capability with an empty/denied claim list is an authoritative rejection for
  // this event. Do not fall back to the batch-level `resolution.claimAuthorization`, which could
  // otherwise label a mismatched event as an authenticated Adapter.
  if (trusted) return 'inferred';
  if (resolution.authenticated && resolution.claimAuthorization) {
    if (adapterEvent && resolution.claimAuthority === 'agent_adapter') return 'authenticated_adapter';
    if (resolution.claimAuthority === 'application') return 'server_graph';
  }
  return 'inferred';
}

function hasAuthorizedSemanticClaim(
  meta: T.EventMeta,
  resolution: IngestionSourceResolution,
  authority: 'application' | 'agent_adapter',
): boolean {
  const trusted = serverTrustedCorrelationContext(meta)?.sourceTrust;
  if (trusted) {
    return trusted.authenticated === true && trusted.allowedClaims.includes(
      authority === 'agent_adapter' ? 'agent_adapter' : 'application_trace',
    );
  }
  return resolution.authenticated
    && resolution.claimAuthorization
    && resolution.claimAuthority === authority;
}

function isLlmEndpoint(inner: Record<string, unknown>): boolean {
  const a = inner as { peer?: string; sni?: string; query?: string };
  const peer = a.peer ?? '';
  const sni = a.sni ?? '';
  const query = a.query ?? '';
  return LLM_ENDPOINTS.some((e) => peer === e || (sni !== '' && sni.includes(e)) || (query !== '' && query.includes(e)));
}

function eventCategory(kind: string): T.EventCategory {
  if (kind === 'ToolExec' || kind === 'AgentTool') return 'tool';
  if (['ToolResult', 'UserMessage', 'ModelMessage', 'LlmResponse', 'NodeRun'].includes(kind)) {
    return kind === 'ToolResult' ? 'tool' : kind === 'NodeRun' ? 'runtime' : 'llm';
  }
  if (kind === 'Egress' || kind === 'Dns' || kind === 'SslContent') return 'network';
  if (kind === 'FileAccess' || kind === 'FileDelete') return 'file';
  if (kind === 'LlmCall' || kind === 'LlmApi' || kind === 'LlmInteraction' || kind === 'AgentPlaintextEvidence') return 'llm';
  if (kind === 'SecurityAction') return 'security';
  if (kind === 'ProcessExit') return 'process';
  if (kind === 'RuntimeEvent' || kind === 'AgentInvocation' || kind === 'SystemContext') return 'runtime';
  return 'unknown';
}

const TOKEN_COUNTER_KEY = /(^|_)(token_count|prompt_tokens|completion_tokens|total_tokens|input_tokens|output_tokens)($|_)/;
const SENSITIVE_KEY = /(^|_)(authorization|api_key|apikey|access_token|accesstoken|refresh_token|refreshtoken|id_token|idtoken|token|secret|password|passwd|credential|credentials)($|_)/;
const GENAI_SENSITIVE_CONTENT_KEY = /^gen_ai_(?:tool_call_(?:arguments|result)|input_messages|output_messages)$/u;

function sensitiveAttributeKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return GENAI_SENSITIVE_CONTENT_KEY.test(normalized) || (
    !TOKEN_COUNTER_KEY.test(normalized) && SENSITIVE_KEY.test(normalized)
  );
}

function redact(s: string): string {
  return s
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^"'\s,}&]+/gi, '$1[redacted]')
    .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|credential)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi, '$1[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-[redacted]');
}

// Endpoint-bearing attributes are a separate privacy boundary from ordinary text.  A producer
// may put a bearer/API token in URL userinfo or in an arbitrary query parameter name, so key-name
// redaction alone is insufficient.  Keep only the transport scheme (when present), host, explicit
// port and path; never persist URL query, fragment or authority userinfo.  The key set is generic
// and intentionally contains no product/version names.
function endpointAttributeKey(key?: string): boolean {
  if (!key) return false;
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (['endpoint', 'url', 'uri', 'peer', 'sni', 'target', 'host', 'hostname', 'address', 'destination'].includes(normalized)) {
    return true;
  }
  return /(?:^|_)(?:endpoint|url|uri|server_address|net_peer_name|net_peer_address|network_peer_address|peer_service|tool_endpoint|rpc_service|destination_address)(?:_|$)/u.test(normalized);
}

function endpointLooksStructured(value: string): boolean {
  // Plain service names (for example `peer.service=worker`) should remain readable.  Parse only
  // values that carry URL structure or an authority/path delimiter; this also catches malformed
  // endpoint strings so the fallback can still remove userinfo/query safely.
  return /(?:^[a-z][a-z0-9+.-]*:\/\/|^[^/?#\s]+:\d{1,5}(?:[/?#]|$)|[/?#@])/iu.test(value);
}

function stripEndpointDecorations(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f"'`,;]/gu, '')
    .split(/[?#]/u)[0]
    .trim();
  const scheme = cleaned.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/iu);
  const prefix = scheme?.[1] ?? '';
  let rest = scheme?.[2] ?? cleaned;
  const authorityEnd = rest.search(/[\/]/u);
  const authority = authorityEnd >= 0 ? rest.slice(0, authorityEnd) : rest;
  const path = authorityEnd >= 0 ? rest.slice(authorityEnd) : '';
  const userInfoAt = authority.lastIndexOf('@');
  if (userInfoAt >= 0) rest = `${authority.slice(userInfoAt + 1)}${path}`;
  return `${prefix}${rest}`.slice(0, 240);
}

function sanitizeEndpointAttributeValue(value: string, key?: string): string {
  const text = value.trim().replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 1_000);
  if (!endpointAttributeKey(key) || !endpointLooksStructured(text)) return text.slice(0, 240);
  const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(text);
  const candidate = explicitScheme ? text : `http://${text}`;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.trim();
    if (!host) return stripEndpointDecorations(text);
    const protocol = explicitScheme ? parsed.protocol.replace(/:$/u, '') : '';
    // WHATWG URL omits default ports. Recover an explicitly supplied port so the endpoint's
    // network identity remains useful for correlation while still validating its range.
    const authority = candidate.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu)?.[1] ?? '';
    const authorityWithoutUser = authority.slice(authority.lastIndexOf('@') + 1);
    const explicitPort = authorityWithoutUser.match(/:(\d{1,5})$/u)?.[1];
    const portNumber = Number(parsed.port || explicitPort || '');
    const port = Number.isInteger(portNumber) && portNumber > 0 && portNumber <= 65_535
      ? String(portNumber) : '';
    const pathname = parsed.pathname && parsed.pathname !== '/'
      ? parsed.pathname.slice(0, 240)
      : parsed.pathname === '/' ? '/' : '';
    return `${protocol ? `${protocol}://` : ''}${host}${port ? `:${port}` : ''}${pathname}`.slice(0, 240);
  } catch {
    return stripEndpointDecorations(text);
  }
}

function sanitizePreviewValue(value: unknown, key = '', depth = 0): unknown {
  if (depth > 6) return '[depth-limited]';
  if (typeof value === 'string') {
    if (sensitiveAttributeKey(key)) return '[redacted]';
    const redacted = redact(value);
    return endpointAttributeKey(key) ? sanitizeEndpointAttributeValue(redacted, key) : sanitizeInlineEndpointLiterals(redacted).slice(0, 1_800);
  }
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => sanitizePreviewValue(item, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 120)
      .map(([childKey, childValue]) => [childKey, sanitizePreviewValue(childValue, childKey, depth + 1)]));
  }
  return value;
}

function sanitizeInlineEndpointLiterals(value: string): string {
  return value.replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)[^\s"'<>]+/giu, (match) => {
    const trailing = match.match(/[)},.;]+$/u)?.[0] ?? '';
    const core = trailing ? match.slice(0, -trailing.length) : match;
    return `${sanitizeEndpointAttributeValue(core, 'endpoint')}${trailing}`;
  });
}

function sanitizeRawPreview(value: unknown, limit = 1_800): string | undefined {
  const source = typeof value === 'string' ? value : JSON.stringify(value);
  if (!source) return undefined;
  try {
    const serialized = JSON.stringify(sanitizePreviewValue(JSON.parse(source)));
    return serialized ? serialized.slice(0, limit) : undefined;
  } catch {
    // Most previews are JSON lines. For an opaque producer string, scrub obvious URL literals as
    // a final bounded fallback; endpoint fields in parsed JSON take the key-aware path above.
    const safe = sanitizeInlineEndpointLiterals(redact(source));
    return safe.slice(0, limit);
  }
}

function attrValue(v: unknown, key?: string): T.EventAttributeValue | undefined {
  if (key && sensitiveAttributeKey(key)) return '[redacted]';
  if (typeof v === 'string') {
    const redacted = redact(v);
    return endpointAttributeKey(key)
      ? sanitizeEndpointAttributeValue(redacted, key)
      : redacted.slice(0, 240);
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  return undefined;
}

function compactAttributes(kind: string, inner: Record<string, unknown>, id: { task?: string | number }): Record<string, T.EventAttributeValue> {
  const a = inner as Record<string, unknown> & { argv?: string[] };
  const attrs: Record<string, T.EventAttributeValue> = {};
  for (const key of [
    'pid',
    'ppid',
    'uid',
    'cwd',
    'comm',
    'exe',
    'cgroup',
    'systemdUnit',
    'hostId',
    'eventTimeNs',
    'startTimeNs',
    'peer',
    'port',
    'query',
    'path',
    'write',
    'accessMode',
    'sni',
    'kind',
    'prompt_tokens',
    'completion_tokens',
    'argv_truncated',
    'argv_incomplete',
    'exec_confirmed',
    'argv_source',
    'captured_argc',
    'captured_bytes',
    'observed_argc',
    'observed_bytes',
    'repeatCount',
    'repeat_count',
    'firstEventAt',
    'first_event_at',
    'lastEventAt',
    'last_event_at',
    'aggregationWindowMs',
    'aggregation_window_ms',
    'exit_code',
    'exitCode',
    'status',
    'signal',
  ]) {
    const v = attrValue(a[key], key);
    if (v !== undefined) attrs[key] = v;
  }
  if (kind === 'FileAccess') {
    attrs.fileOperation = 'open';
    if (attrs.accessMode === undefined && typeof a.write === 'boolean') {
      attrs.accessMode = a.write ? 'write_only' : 'read_only';
    }
  }
  const aggregationAliases: Array<[string, string]> = [
    ['repeat_count', 'repeatCount'],
    ['first_event_at', 'firstEventAt'],
    ['last_event_at', 'lastEventAt'],
    ['aggregation_window_ms', 'aggregationWindowMs'],
  ];
  for (const [legacy, canonical] of aggregationAliases) {
    if (attrs[canonical] === undefined && attrs[legacy] !== undefined) attrs[canonical] = attrs[legacy];
  }
  if (Array.isArray(a.argv)) {
    attrs.argv = redact(a.argv.join(' ')).slice(0, 300);
    if (kind === 'ToolExec') {
      const shellFlag = a.argv.findIndex((part) => part === '-c' || part === '-lc');
      const shellCommand = shellFlag >= 0 && typeof a.argv[shellFlag + 1] === 'string'
        ? a.argv[shellFlag + 1]
        : undefined;
      if (shellCommand) {
        // Preserve equality without persisting the command. The linker consumes this only after
        // the Source has been authenticated as Observer evidence.
        attrs['anysentry.kernel.command_hash'] = createHash('sha256').update(shellCommand).digest('hex');
      }
    }
  }
  if (id.task != null) attrs.observerTask = String(id.task).slice(0, 120);
  attrs.observerKind = kind;
  return attrs;
}

function interactionUsageCounters(
  kind: string,
  inner: Record<string, unknown>,
): { attributes: Record<string, number>; total?: number } {
  if (kind !== 'LlmInteraction') return { attributes: {} };
  const usage = obj(inner.usage);
  if (!usage || usage.source !== 'provider_reported') return { attributes: {} };
  const counter = (key: string) => {
    const value = finiteNumber(usage[key]);
    return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };
  const input = counter('inputTokens');
  const output = counter('outputTokens');
  const reportedTotal = counter('totalTokens');
  const total = reportedTotal ?? (
    input !== undefined && output !== undefined && input + output <= Number.MAX_SAFE_INTEGER
      ? input + output
      : undefined
  );
  return {
    attributes: {
      ...(input !== undefined ? { 'llm.usage.input_tokens': input } : {}),
      ...(output !== undefined ? { 'llm.usage.output_tokens': output } : {}),
      ...(total !== undefined ? { 'llm.usage.total_tokens': total } : {}),
      ...(counter('cachedInputTokens') !== undefined
        ? { 'llm.usage.cached_input_tokens': counter('cachedInputTokens')! }
        : {}),
      ...(counter('cacheCreationInputTokens') !== undefined
        ? { 'llm.usage.cache_creation_input_tokens': counter('cacheCreationInputTokens')! }
        : {}),
      ...(counter('reasoningOutputTokens') !== undefined
        ? { 'llm.usage.reasoning_output_tokens': counter('reasoningOutputTokens')! }
        : {}),
    },
    total,
  };
}

function processFromObserverLine(process: unknown): T.ProcessContext | undefined {
  if (!process || typeof process !== 'object') return undefined;
  const p = process as Record<string, unknown>;
  const numberField = (key: string) => {
    const value = Number(p[key]);
    return Number.isFinite(value) ? value : undefined;
  };
  const stringField = (key: string) => {
    const value = p[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const stringLikeField = (...keys: string[]) => {
    for (const key of keys) {
      const value = p[key];
      if ((typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') && String(value).trim()) {
        return String(value).trim();
      }
    }
    return undefined;
  };
  const ctx: T.ProcessContext = {
    pid: numberField('pid'),
    ppid: numberField('ppid'),
    pidNamespace: stringLikeField('pidNamespace', 'pid_namespace'),
    namespacePid: numberField('namespacePid') ?? numberField('namespace_pid'),
    namespacePpid: numberField('namespacePpid') ?? numberField('namespace_ppid'),
    uid: numberField('uid'),
    comm: stringField('comm'),
    exe: stringField('exe'),
    cwd: stringField('cwd'),
    cgroup: stringField('cgroup'),
    cgroupId: stringLikeField('cgroupId', 'cgroup_id'),
    systemdUnit: stringLikeField('systemdUnit', 'systemd_unit'),
    hostId: stringLikeField('hostId', 'host_id'),
    bootId: stringLikeField('bootId', 'boot_id'),
    eventTimeNs: stringLikeField('eventTimeNs', 'event_time_ns'),
    startTimeNs: stringLikeField('startTimeNs', 'start_time_ns'),
    startTimeTicks: stringLikeField('startTimeTicks', 'start_time_ticks'),
    processGenerationKey: stringLikeField('processGenerationKey', 'process_generation_key'),
    parentProcessGenerationKey: stringLikeField('parentProcessGenerationKey', 'parent_process_generation_key'),
    mountNamespace: numberField('mountNamespace') ?? numberField('mount_namespace'),
    terminalContextId: stringLikeField('terminalContextId', 'terminal_context_id'),
    sshConnectionId: stringLikeField('sshConnectionId', 'ssh_connection_id'),
    lifecycleSource: parseProcessLifecycleSource(stringLikeField('lifecycleSource', 'lifecycle_source')),
    lifecycleReason: parseUnknownReason(stringLikeField('lifecycleReason', 'lifecycle_reason')),
  };
  return Object.values(ctx).some((value) => value !== undefined) ? ctx : undefined;
}

function exactUnixNs(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]{15,20}$/u.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function exactU64(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[0-9]{1,20}$/u.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= 18_446_744_073_709_551_615n ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function byteValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 255
    ? value
    : undefined;
}

function unixNsMillis(value: string | undefined): number | undefined {
  if (!value) return undefined;
  try {
    const millis = BigInt(value) / 1_000_000n;
    return millis <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(millis) : undefined;
  } catch {
    return undefined;
  }
}

function trustedCollectorEventTime(meta: T.EventMeta, trusted: boolean): number | undefined {
  if (!trusted) return undefined;
  const eventAt = unixNsMillis(meta.eventAtUnixNs);
  const receivedAt = unixNsMillis(meta.receivedAtUnixNs);
  if (eventAt === undefined || receivedAt === undefined || receivedAt < eventAt) return undefined;
  // A calibrated Collector clock may differ slightly from the API. Reject impossible/far-future
  // values so an authenticated but broken node cannot move reviews or retention arbitrarily.
  const latestTrustedTime = Date.now() + 5 * 60_000;
  if (
    eventAt < Date.UTC(2000, 0, 1)
    || eventAt > latestTrustedTime
    || receivedAt < Date.UTC(2000, 0, 1)
    || receivedAt > latestTrustedTime
  ) return undefined;
  return eventAt;
}

/**
 * A producer Run ID is a semantic claim, not a transport identity.  Only the out-of-band
 * server trust context created by source authentication/claim authorization may promote it to a
 * durable Run field.  This keeps an arbitrary webhook/collector payload from choosing the Run
 * namespace used by correlation and conversation projections.
 */
function trustedProducerRunId(meta: T.EventMeta): string | undefined {
  const context = serverTrustedCorrelationContext(meta);
  const sourceTrust = context?.sourceTrust;
  if (!context || !sourceTrust?.authenticated || sourceTrust.allowedClaims.length === 0) return undefined;
  const raw = sourceTrust.authority === 'agent_adapter'
    ? context.claims?.agentAdapter?.runId
    : context.claims?.application?.runId;
  return strictIdentityText(raw, 512);
}

function summarize(kind: string, inner: Record<string, unknown>): string {
  const a = inner as { argv?: string[]; peer?: string; port?: number; query?: string; path?: string; sni?: string; kind?: string; model?: string; endpoint?: string };
  if (kind === 'ToolExec') return redact((a.argv ?? []).join(' ')).slice(0, 80) || 'exec';
  if (kind === 'Egress') return `egress → ${a.peer ?? '?'}${a.port ? `:${a.port}` : ''}`;
  if (kind === 'Dns') return `dns ${a.query ?? ''}`;
  if (kind === 'FileAccess') return `file ${a.path ?? ''}`;
  if (kind === 'SslContent') return 'ssl content';
  if (kind === 'SecurityAction') return `security ${a.kind ?? ''}`;
  if (kind === 'LlmCall') return `llm ${a.sni ?? ''}`;
  if (kind === 'LlmInteraction') return `llm interaction ${a.model ?? ''} ${a.endpoint ?? ''}`.trim();
  return kind;
}

function safeIdentityHint(value: unknown, max = 240): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)
    ? trimmed
    : undefined;
}

/** Fill EventMeta from an a3s-observer line's identity + event, honoring any explicitly-given fields. */
function deriveMeta(line: string, given: Partial<T.EventMeta>): T.EventMeta {
  let id: { agent?: string; task?: string | number; session?: string } = {};
  let eventKey = 'Event';
  let inner: Record<string, unknown> = {};
  let process: T.ProcessContext | undefined;
  let eventAtUnixNs: string | undefined;
  let receivedAtUnixNs: string | undefined;
  let captureEpoch: string | undefined;
  let captureProfileCode: number | undefined;
  let captureActionCode: number | undefined;
  let captureAuthorityCode: number | undefined;
  let captureDispositionCode: number | undefined;
  let captureSelected: boolean | undefined;
  let captureFlags: number | undefined;
  let rawObservationId: string | undefined;
  let rawObservationRevision: number | undefined;
  let lineLogicalAgentId: string | undefined;
  let lineLogicalDefinitionId: string | undefined;
  let lineLogicalScopeMode: T.EventMeta['logicalScopeMode'];
  let lineTerminalContextId: string | undefined;
  let lineOwnerId: string | undefined;
  let lineTenantId: string | undefined;
  let lineProfile: string | undefined;
  let lineProfileVersion: string | undefined;
  try {
    const o = JSON.parse(line) as {
      identity?: typeof id;
      process?: unknown;
      rawObservation?: Record<string, unknown>;
      raw_observation?: Record<string, unknown>;
      logicalAgentId?: unknown;
      logicalDefinitionId?: unknown;
      logicalScopeMode?: unknown;
      terminalContextId?: unknown;
      tenantId?: unknown;
      ownerId?: unknown;
      profile?: unknown;
      profileVersion?: unknown;
      event?: Record<string, Record<string, unknown>>;
      eventAtUnixNs?: unknown;
      receivedAtUnixNs?: unknown;
      captureEpoch?: unknown;
      captureProfile?: unknown;
      captureAction?: unknown;
      captureAuthority?: unknown;
      captureDisposition?: unknown;
      captureSelected?: unknown;
      captureFlags?: unknown;
    };
    id = o.identity ?? {};
    process = processFromObserverLine(o.process);
    const raw = o.rawObservation ?? o.raw_observation;
    rawObservationId = typeof raw?.observationId === 'string' ? raw.observationId.trim() : undefined;
    rawObservationRevision = Number.isSafeInteger(raw?.revision) && Number(raw?.revision) > 0
      ? Number(raw?.revision) : undefined;
    const runtime = raw?.runtime && typeof raw.runtime === 'object' && !Array.isArray(raw.runtime)
      ? raw.runtime as Record<string, unknown> : undefined;
    const rawLogical = raw?.logicalAgentId ?? raw?.logical_agent_id;
    lineLogicalAgentId = typeof o.logicalAgentId === 'string' ? o.logicalAgentId.trim()
      : typeof rawLogical === 'string' ? rawLogical.trim() : undefined;
    const rawDefinition = raw?.logicalDefinitionId ?? raw?.logical_definition_id;
    lineLogicalDefinitionId = typeof o.logicalDefinitionId === 'string' ? o.logicalDefinitionId.trim()
      : typeof rawDefinition === 'string' ? rawDefinition.trim() : undefined;
    const scope = o.logicalScopeMode ?? raw?.logicalScopeMode ?? raw?.logical_scope_mode;
    lineLogicalScopeMode = ['registered_definition', 'workflow_definition', 'service_definition', 'terminal', 'unresolved']
      .includes(String(scope)) ? scope as T.EventMeta['logicalScopeMode'] : undefined;
    const terminal = o.terminalContextId ?? runtime?.terminalContextId ?? runtime?.terminal_context_id;
    lineTerminalContextId = typeof terminal === 'string' ? terminal.trim() : undefined;
    const tenant = o.tenantId ?? raw?.tenantId ?? raw?.tenant_id;
    lineTenantId = typeof tenant === 'string' ? tenant.trim() : undefined;
    const owner = o.ownerId ?? raw?.ownerId ?? raw?.owner_id;
    lineOwnerId = typeof owner === 'string' ? owner.trim() : undefined;
    const profile = o.profile ?? raw?.profile;
    lineProfile = typeof profile === 'string' ? profile.trim() : undefined;
    const profileVersion = o.profileVersion ?? raw?.profileVersion ?? raw?.profile_version;
    lineProfileVersion = typeof profileVersion === 'string' ? profileVersion.trim() : undefined;
    eventAtUnixNs = exactUnixNs(o.eventAtUnixNs);
    receivedAtUnixNs = exactUnixNs(o.receivedAtUnixNs);
    captureEpoch = exactU64(o.captureEpoch);
    captureProfileCode = byteValue(o.captureProfile);
    captureActionCode = byteValue(o.captureAction);
    captureAuthorityCode = byteValue(o.captureAuthority);
    captureDispositionCode = byteValue(o.captureDisposition);
    captureSelected = typeof o.captureSelected === 'boolean' ? o.captureSelected : undefined;
    captureFlags = byteValue(o.captureFlags);
    const ev = o.event ?? {};
    eventKey = Object.keys(ev)[0] ?? 'Event';
    inner = ev[eventKey] ?? {};
  } catch {
    // not JSON — leave defaults; sentry.evaluate will return null and the event is dropped
  }
  const agentId = given.agentId ?? id.agent ?? 'unknown';
  const cwd = typeof inner.cwd === 'string' ? inner.cwd : undefined;
  const uid = inner.uid;
  const explicitSession = typeof given.sessionId === 'string' && given.sessionId.trim()
    ? given.sessionId.trim()
    : typeof id.session === 'string' && id.session.trim() ? id.session.trim() : undefined;
  const fallbackBoundary = given.sourceEventId
    ?? given.rawObservationId
    ?? given.invocationId
    ?? (given.receivedAt !== undefined ? String(given.receivedAt) : undefined)
    // No producer boundary is available for an old/tokenless line.  A monotonic process-local
    // nonce keeps identical stateless POSTs separate without writing a secret or trusting a PID.
    ?? `request-${Date.now()}-${ephemeralMetaSequence += 1}`;
  const legacySessionAnchor = typeof id.agent === 'string' && id.agent.trim()
    ? id.agent.trim()
    : id.task != null ? `task-${id.task}` : undefined;
  const sessionFallback = explicitSession
    ?? `ephemeral-${createHash('sha256').update(`${line}\u0000${fallbackBoundary}`).digest('hex').slice(0, 24)}`;
  const sessionIdSource: T.SessionIdSource = explicitSession
    ? (given.sessionIdSource === 'provider' || given.sessionIdSource === 'authenticated_adapter'
      ? given.sessionIdSource
      : 'legacy_observer_session')
    : id.agent ? 'legacy_agent_fallback'
      : id.task != null ? 'legacy_task_fallback' : 'per_request';
  const sessionIdentityQuality: T.SessionIdentityQuality = sessionIdSource === 'authenticated_adapter'
    || sessionIdSource === 'provider' ? 'confirmed'
    : sessionIdSource === 'legacy_observer_session' ? 'inferred' : 'ephemeral';
  const rawAttributes = given.attributes ?? {};
  const logicalAgentId = safeIdentityHint(given.logicalAgentId)
    ?? safeIdentityHint(lineLogicalAgentId)
    ?? safeIdentityHint(rawAttributes['anysentry.logical_agent_id']);
  const logicalDefinitionId = safeIdentityHint(given.logicalDefinitionId)
    ?? safeIdentityHint(lineLogicalDefinitionId)
    ?? safeIdentityHint(rawAttributes['anysentry.logical_definition_id']);
  const logicalScopeMode = given.logicalScopeMode ?? lineLogicalScopeMode;
  const terminalContextId = safeIdentityHint(given.terminalContextId)
    ?? safeIdentityHint(lineTerminalContextId)
    ?? safeIdentityHint(rawAttributes['anysentry.terminal_context_id']);
  const tenantId = safeIdentityHint(given.tenantId)
    ?? safeIdentityHint(rawAttributes.tenantId)
    ?? safeIdentityHint(lineTenantId);
  const ownerId = safeIdentityHint(given.ownerId)
    ?? safeIdentityHint(rawAttributes.ownerId)
    ?? safeIdentityHint(lineOwnerId);
  const profile = safeIdentityHint(given.profile)
    ?? safeIdentityHint(rawAttributes.profile)
    ?? safeIdentityHint(lineProfile);
  const profileVersion = safeIdentityHint(given.profileVersion, 120)
    ?? safeIdentityHint(rawAttributes.profileVersion)
    ?? safeIdentityHint(lineProfileVersion, 120);
  // Surface an agent→LLM-endpoint connection as an LlmCall even when it isn't an SNI-classified
  // public provider (internal/self-hosted endpoints, plain HTTP).
  const isLlm = (eventKey === 'Egress' || eventKey === 'Dns') && isLlmEndpoint(inner);
  const peer = (inner as { peer?: string; query?: string }).peer ?? (inner as { query?: string }).query ?? '';
  const usage = interactionUsageCounters(eventKey, inner);
  const canonicalAttributes: Record<string, T.EventAttributeValue> = {
    ...sanitizeEventAttributes(given.attributes),
    ...compactAttributes(eventKey, inner, id),
    ...usage.attributes,
    'anysentry.session.identity_quality': sessionIdentityQuality,
    'anysentry.session.id_source': sessionIdSource,
    ...(tenantId ? { tenantId } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(profile ? { profile } : {}),
    ...(profileVersion ? { profileVersion } : {}),
    ...(logicalAgentId ? { 'anysentry.logical_agent_id': logicalAgentId } : {}),
    ...(logicalDefinitionId ? { 'anysentry.logical_definition_id': logicalDefinitionId } : {}),
    ...(logicalScopeMode ? { 'anysentry.logical_scope_mode': logicalScopeMode } : {}),
    ...(terminalContextId ? { 'anysentry.terminal_context_id': terminalContextId } : {}),
  };
  return {
    agentId,
    workspacePath: given.workspacePath ?? cwd ?? `agent://${agentId}`,
    ...(tenantId ? { tenantId } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(profile ? { profile } : {}),
    ...(profileVersion ? { profileVersion } : {}),
    ...(given.deploymentId ? { deploymentId: given.deploymentId } : {}),
    ...(given.deploymentRevision ? { deploymentRevision: given.deploymentRevision } : {}),
    ...(given.environmentId ? { environmentId: given.environmentId } : {}),
    // Keep the required legacy field populated for old Judge consumers, but expose the provenance
    // explicitly. Legacy agent/task fallbacks are ephemeral/inferred and are never used as a
    // confirmed provider Session by the canonical resolver.
    sessionId: sessionFallback,
    sessionIdentityQuality,
    sessionIdSource,
    ...(legacySessionAnchor && !explicitSession
      ? { legacySessionId: legacySessionAnchor } : {}),
    sessionMode: sessionIdentityQuality === 'ephemeral' ? 'ephemeral' : 'conversation',
    rawObservationId,
    rawObservationRevision,
    logicalAgentId,
    logicalDefinitionId,
    logicalScopeMode,
    terminalContextId,
    userId: given.userId ?? (uid != null ? `uid:${uid}` : 'system'),
    eventKind: given.eventKind ?? (isLlm ? 'LlmCall' : eventKey),
    eventCategory: given.eventCategory ?? eventCategory(isLlm ? 'LlmCall' : eventKey),
    activityContext: given.activityContext,
    activitySubtype: given.activitySubtype,
    source: given.source ?? 'observer',
    traceId: given.traceId,
    invocationId: given.invocationId,
    toolCallId: given.toolCallId,
    spanId: given.spanId,
    parentSpanId: given.parentSpanId,
    // A provider Session is not a Run.  Keep the optional Run empty unless an Adapter/producer
    // supplied one explicitly; the Judge adds a separate event-local compatibility ID and marks
    // its provenance when the legacy required field must be populated.
    runId: given.runId,
    runIdSource: given.runId ? (given.runIdSource ?? 'producer') : undefined,
    turnId: given.turnId,
    taskId: given.taskId ?? (id.task != null ? String(id.task) : undefined),
    sourceEventId: given.sourceEventId,
    // Timing and Ring-before decisions are evidence emitted inside the Collector-authenticated raw
    // record. Never accept envelope copies: JSON numbers can already have lost u64 precision, and
    // an envelope must not be able to replace the decision that accompanied the kernel record.
    eventAtUnixNs,
    receivedAtUnixNs,
    captureEpoch,
    captureProfileCode,
    captureActionCode,
    captureAuthorityCode,
    captureDispositionCode,
    captureSelected,
    captureFlags,
    // Envelope attributes may add producer context, but cannot replace fields decoded from the raw
    // record (notably ProcessExit status/signal and command hashes).
    attributes: canonicalAttributes,
    classificationSemantics: given.classificationSemantics,
    // Process generation is structural evidence and therefore shares the raw-record trust boundary
    // with event time and capture decisions.
    process,
    attribution: given.attribution,
    rawPreview: sanitizeRawPreview(given.rawPreview ?? line),
    subject: given.subject ?? (isLlm ? `LLM 调用 → ${peer}` : summarize(eventKey, inner)),
    tokenCount: given.tokenCount ?? usage.total,
    latencyMs: given.latencyMs,
  };
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function strField(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function numField(o: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = o[key];
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function nonNegativeSafeIntegerField(o: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = o[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return undefined;
}

function boolField(o: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = o[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function strArrayField(o: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const v = o[key];
    if (Array.isArray(v)) return v.map((item) => String(item)).filter(Boolean);
  }
  return undefined;
}

function parseCollectorHeartbeatLine(line: string): T.CollectorRawHeartbeatRequest | null {
  try {
    const parsed = JSON.parse(line) as { event?: Record<string, unknown> };
    const hb = obj(parsed.event?.CollectorHeartbeat);
    if (!hb) return null;
    const eventKindCounts: Record<string, number> = {};
    const countMap: Array<[string, string]> = [
      ['exec', 'ToolExec'],
      ['exit', 'ProcessExit'],
      ['egress', 'Egress'],
      ['dns', 'Dns'],
      ['llm', 'LlmCall'],
      ['ssl', 'SslContent'],
      ['sec', 'SecurityAction'],
    ];
    for (const [sourceKey, kind] of countMap) {
      const count = numField(hb, sourceKey);
      if (count !== undefined) eventKindCounts[kind] = count;
    }
    const fileAccess = numField(hb, 'file_access');
    const fileDelete = numField(hb, 'file_delete');
    const legacyFile = numField(hb, 'file');
    if (fileAccess !== undefined) eventKindCounts.FileAccess = fileAccess;
    else if (legacyFile !== undefined) eventKindCounts.FileAccess = legacyFile;
    if (fileDelete !== undefined) eventKindCounts.FileDelete = fileDelete;
    const explicitCounts = obj(hb.eventKindCounts) ?? obj(hb.event_kind_counts);
    if (explicitCounts) {
      for (const [key, value] of Object.entries(explicitCounts)) {
        const count = Number(value);
        if (Number.isFinite(count)) eventKindCounts[key] = count;
      }
    }
    const exec = nonNegativeSafeIntegerField(hb, 'exec');
    const execTruncated = nonNegativeSafeIntegerField(hb, 'execTruncated', 'exec_truncated');
    const execIncomplete = nonNegativeSafeIntegerField(hb, 'execIncomplete', 'exec_incomplete');
    const execReassemblyTimeout = nonNegativeSafeIntegerField(hb, 'execReassemblyTimeout', 'exec_reassembly_timeout');
    const shutdownFinal = boolField(hb, 'shutdownFinal', 'shutdown_final');
    const fileFilterEnabled = boolField(hb, 'file_filter_enabled');
    const fileFilterEpoch = numField(hb, 'file_filter_epoch');
    const fileFilterValues = {
      fileAccess,
      fileDelete,
      accessKept: numField(hb, 'file_prefilter_access_kept'),
      accessUnknownKept: numField(hb, 'file_prefilter_access_unknown_kept'),
      accessSampled: numField(hb, 'file_prefilter_access_sampled'),
      accessDropped: numField(hb, 'file_prefilter_access_dropped'),
      accessSuppressed: numField(hb, 'file_prefilter_access_suppressed'),
      deleteKept: numField(hb, 'file_prefilter_delete_kept'),
      deleteUnknownKept: numField(hb, 'file_prefilter_delete_unknown_kept'),
      deleteDropped: numField(hb, 'file_prefilter_delete_dropped'),
      ruleHits: numField(hb, 'file_prefilter_rule_hits'),
      ruleMisses: numField(hb, 'file_prefilter_rule_misses'),
      staleRules: numField(hb, 'file_prefilter_stale_rules'),
      accessRingDropped: numField(hb, 'file_access_ring_dropped'),
      deleteRingDropped: numField(hb, 'file_delete_ring_dropped'),
    };
    const reportsFileFilterMetrics = fileFilterEnabled !== undefined || fileFilterEpoch !== undefined ||
      Object.values(fileFilterValues).some((value) => value !== undefined);
    // Evidence is fail-closed: older or malformed raw schemas remain visible as heartbeats, but
    // cannot masquerade as complete graceful-shutdown/argv-quality proof.
    const reportsExecEvidence = [exec, execTruncated, execIncomplete, execReassemblyTimeout]
      .every((value) => value !== undefined) &&
      [execTruncated, execIncomplete, execReassemblyTimeout]
        .every((value) => (value as number) <= (exec as number)) &&
      shutdownFinal !== undefined;
    const legacyCounterTemporality = strField(hb, 'legacyCounterTemporality', 'legacy_counter_temporality');
    const captureProfileMetrics = parseCollectorCaptureProfileMetrics(
      hb.captureProfile ?? hb.capture_profile,
    );
    return {
      collectorId: canonicalCollectorId(strField(hb, 'collectorId', 'collector_id')),
      nodeName: strField(hb, 'nodeName', 'node_name'),
      namespace: strField(hb, 'namespace'),
      podName: strField(hb, 'podName', 'pod_name'),
      version: strField(hb, 'version'),
      mode: strField(hb, 'mode'),
      status: strField(hb, 'status') as T.CollectorReportedStatus | undefined,
      attachedProbes: numField(hb, 'attachedProbes', 'attached_probes'),
      enabledFeatures: strArrayField(hb, 'enabledFeatures', 'enabled_features'),
      intervalSecs: numField(hb, 'intervalSecs', 'interval_secs'),
      eventKindCounts,
      droppedEvents: numField(hb, 'droppedEvents', 'dropped'),
      outputDropped: numField(hb, 'outputDropped', 'output_dropped'),
      observedAgents: numField(hb, 'observedAgents', 'observed_agents'),
      errorCount: numField(hb, 'errorCount', 'error_count'),
      legacyCounterTemporality: legacyCounterTemporality === 'delta' || legacyCounterTemporality === 'cumulative'
        ? legacyCounterTemporality
        : undefined,
      pipelineAccounting: normalizePipelineAccounting(hb.pipelineAccounting ?? hb.pipeline_accounting),
      captureProfileMetrics,
      execEvidence: reportsExecEvidence ? {
        exec: exec as number,
        execTruncated: execTruncated as number,
        execIncomplete: execIncomplete as number,
        execReassemblyTimeout: execReassemblyTimeout as number,
        shutdownFinal: shutdownFinal as boolean,
      } : undefined,
      fileFilterMetrics: reportsFileFilterMetrics ? {
        fileAccess: fileAccess ?? legacyFile ?? 0,
        fileDelete: fileDelete ?? 0,
        accessKept: fileFilterValues.accessKept ?? 0,
        accessUnknownKept: fileFilterValues.accessUnknownKept ?? 0,
        accessSampled: fileFilterValues.accessSampled ?? 0,
        accessDropped: fileFilterValues.accessDropped ?? 0,
        accessSuppressed: fileFilterValues.accessSuppressed ?? 0,
        deleteKept: fileFilterValues.deleteKept ?? 0,
        deleteUnknownKept: fileFilterValues.deleteUnknownKept ?? 0,
        deleteDropped: fileFilterValues.deleteDropped ?? 0,
        ruleHits: fileFilterValues.ruleHits ?? 0,
        ruleMisses: fileFilterValues.ruleMisses ?? 0,
        staleRules: fileFilterValues.staleRules ?? 0,
        accessRingDropped: fileFilterValues.accessRingDropped ?? 0,
        deleteRingDropped: fileFilterValues.deleteRingDropped ?? 0,
        enabled: fileFilterEnabled === true,
        epoch: fileFilterEpoch ?? 0,
        unknownPolicy: strField(hb, 'file_filter_unknown_policy') === 'sample' ? 'sample' : 'keep',
      } : undefined,
      queueDepth: numField(hb, 'queueDepth', 'queue_depth'),
      message: strField(hb, 'message'),
    };
  } catch {
    return null;
  }
}

type HeaderBag = Record<string, string | string[] | undefined>;

function headerValue(headers: HeaderBag | undefined, key: string): string | undefined {
  const value = headers?.[key] ?? headers?.[key.toLowerCase()];
  if (Array.isArray(value)) return value.find(Boolean);
  return value;
}

function bearerToken(headers: HeaderBag | undefined): string | undefined {
  const authorization = headerValue(headers, 'authorization');
  const match = authorization?.match(/^bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function auditActor(headers: HeaderBag | undefined): T.AuditActor {
  const actorType = headerValue(headers, 'x-anysentry-actor-type');
  const type: T.AuditActorType = actorType === 'system' || actorType === 'api' || actorType === 'operator' ? actorType : 'operator';
  const forwardedFor = headerValue(headers, 'x-forwarded-for')?.split(',')[0]?.trim();
  return {
    type,
    id:
      headerValue(headers, 'x-anysentry-actor') ??
      headerValue(headers, 'x-forwarded-user') ??
      headerValue(headers, 'x-user-email') ??
      headerValue(headers, 'x-operator') ??
      'operator',
    displayName: headerValue(headers, 'x-anysentry-actor-name') ?? headerValue(headers, 'x-user-name'),
    sourceIp: forwardedFor ?? headerValue(headers, 'x-real-ip'),
    userAgent: headerValue(headers, 'user-agent'),
  };
}

const SEVERITY_RANK: Record<T.Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

function selector(value: unknown, limit = 500): string | undefined {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  return text ? text.slice(0, limit) : undefined;
}

function evidenceAttrText(attrs: Record<string, T.EventAttributeValue> | undefined, key: string): string | undefined {
  const value = attrs?.[key];
  return value == null ? undefined : selector(value, 500);
}

function evidenceEventCollectorId(event: Pick<T.AgentEventListItem, 'collectorId' | 'sourceId' | 'attributes'> | undefined): string | undefined {
  return selector(event?.collectorId, 180) ?? evidenceAttrText(event?.attributes, 'collectorId');
}

function evidenceEventSourceId(event: Pick<T.AgentEventListItem, 'collectorId' | 'sourceId' | 'attributes'> | undefined): string | undefined {
  return selector(event?.sourceId, 160) ?? evidenceAttrText(event?.attributes, 'sourceId');
}

function prefer<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined && value !== '');
}

function policyBadRequest(error: unknown): BadRequestException {
  if (error instanceof PolicyConfigError) return new BadRequestException(error.message);
  throw error;
}

function bundleId(scope: T.EvidenceBundleScope): string {
  const h = createHash('sha1');
  for (const key of ['primaryType', 'primaryId', 'auditId', 'edgeId', 'eventId', 'incidentId', 'alertId', 'taskId', 'objectiveId', 'issueId', 'deliveryId', 'windowId', 'workspacePath', 'agentId', 'subjectAssetId', 'collectorId', 'sourceId', 'traceId', 'runId', 'sessionId'] as const) {
    h.update(String(scope[key] ?? '')).update('\0');
  }
  return `evb_${h.digest('hex').slice(0, 16)}`;
}

function alertObjectiveId(alert: T.AlertListItem | undefined): string | undefined {
  return alert?.labels?.objectiveId;
}

function remediationObjectiveId(task: T.RemediationListItem | undefined): string | undefined {
  return task?.labels?.objectiveId;
}

function objectiveTarget(objective: T.ObjectiveItem | undefined, targetType: T.ObjectiveTargetType): string | undefined {
  return objective?.targetType === targetType ? objective.targetId : undefined;
}

function splitAgentTargetId(targetId: string | undefined): { workspacePath?: string; agentId?: string } {
  if (!targetId) return {};
  const separator = targetId.lastIndexOf(':');
  if (separator <= 0 || separator >= targetId.length - 1) return { agentId: targetId };
  return {
    workspacePath: targetId.slice(0, separator),
    agentId: targetId.slice(separator + 1),
  };
}

function maintenanceTarget(window: T.MaintenanceWindowItem | undefined, targetType: T.MaintenanceTargetType): string | undefined {
  return window?.targetType === targetType ? window.targetId : undefined;
}

function auditDetailText(audit: T.AuditListItem | undefined, key: string): string | undefined {
  return selector(audit?.details?.[key], 500);
}

function auditResourceId(audit: T.AuditListItem | undefined, resourceType: T.AuditResourceType): string | undefined {
  return audit?.resourceType === resourceType ? audit.resourceId : undefined;
}

function objectiveMatchesScope(objective: T.ObjectiveItem, scope: T.EvidenceBundleScope): boolean {
  if (scope.objectiveId && objective.objectiveId === scope.objectiveId) return true;
  if (objective.targetType === 'workspace') return Boolean(scope.workspacePath && objective.targetId === scope.workspacePath);
  if (objective.targetType === 'agent') {
    const target = splitAgentTargetId(objective.targetId);
    return Boolean(scope.agentId && target.agentId === scope.agentId && (!target.workspacePath || target.workspacePath === scope.workspacePath));
  }
  if (objective.targetType === 'collector') return Boolean(scope.collectorId && objective.targetId === scope.collectorId);
  if (objective.targetType === 'source') return Boolean(scope.sourceId && objective.targetId === scope.sourceId);
  return objective.targetType === 'global' && scope.primaryType === 'scope' && !scope.workspacePath && !scope.agentId && !scope.collectorId && !scope.sourceId;
}

function notificationDeliveryMatchesScope(item: T.NotificationDeliveryItem, scope: T.EvidenceBundleScope): boolean {
  const targetMatches = Boolean(
    (scope.workspacePath || scope.agentId || scope.collectorId || scope.sourceId) &&
      (!scope.workspacePath || item.workspacePath === scope.workspacePath) &&
      (!scope.agentId || item.agentId === scope.agentId) &&
      (!scope.collectorId || item.collectorId === scope.collectorId) &&
      (!scope.sourceId || item.sourceId === scope.sourceId),
  );
  return Boolean(
    (scope.alertId && item.alertId === scope.alertId) ||
    (scope.incidentId && item.incidentId === scope.incidentId) ||
    (scope.eventId && item.eventId === scope.eventId) ||
	    (scope.taskId && item.taskId === scope.taskId) ||
	    (scope.objectiveId && item.objectiveId === scope.objectiveId) ||
	    (scope.issueId && item.issueId === scope.issueId) ||
	    (scope.deliveryId && item.deliveryId === scope.deliveryId) ||
	    targetMatches,
	  );
}

function notificationConfigQueryHasSelector(filter: T.NotificationConfigQuery): boolean {
  return Boolean(
    filter.channelId ||
      filter.routeId ||
      filter.kind ||
      filter.minSeverity ||
      filter.workspacePath ||
      filter.agentId ||
      filter.collectorId ||
      filter.sourceId ||
      filter.owner ||
      filter.team ||
      filter.deliveryId ||
      filter.alertId ||
      filter.incidentId ||
      filter.eventId ||
      filter.taskId ||
      filter.objectiveId ||
      filter.issueId,
  );
}

function maintenanceWindowMatchesScope(
  item: T.MaintenanceWindowItem,
  scope: T.EvidenceBundleScope,
  context: { agentIds?: ReadonlySet<string>; agentKeys?: ReadonlySet<string> } = {},
): boolean {
  if (scope.windowId && item.windowId === scope.windowId) return true;
  if (item.targetType === 'all') return true;
  if (item.targetType === 'workspace') return Boolean(scope.workspacePath && item.targetId === scope.workspacePath);
  if (item.targetType === 'collector') return Boolean(scope.collectorId && item.targetId === scope.collectorId);
  if (item.targetType === 'source') return Boolean(scope.sourceId && item.targetId === scope.sourceId);
  if (item.targetType === 'agent') {
    return Boolean(
      (scope.agentId && (item.targetId === scope.agentId || item.targetId === `${scope.workspacePath ?? ''}:${scope.agentId}`)) ||
        context.agentIds?.has(item.targetId) ||
        context.agentKeys?.has(item.targetId),
    );
  }
  return false;
}

function sortByDateDesc<TItem>(items: TItem[], dateValue: (item: TItem) => string | undefined): TItem[] {
  return items.sort((a, b) => (Date.parse(dateValue(b) ?? '') || 0) - (Date.parse(dateValue(a) ?? '') || 0));
}

function maxSeverity(...items: Array<{ severity?: T.Severity } | undefined>): T.Severity | undefined {
  return items
    .map((item) => item?.severity)
    .filter((severity): severity is T.Severity => Boolean(severity))
    .sort((a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a])[0];
}

function riskCategories(events: T.AgentEventListItem[]): T.EvidenceBundleRiskCategory[] {
  const counts = new Map<string, { riskCategory: string; riskName: string; eventCount: number }>();
  for (const event of events) {
    if (event.verdict === 'allow') continue;
    const cur = counts.get(event.riskCategory);
    counts.set(event.riskCategory, {
      riskCategory: event.riskCategory,
      riskName: event.riskName,
      eventCount: (cur?.eventCount ?? 0) + 1,
    });
  }
  return [...counts.values()].sort((a, b) => b.eventCount - a.eventCount || a.riskCategory.localeCompare(b.riskCategory));
}

function conservativeEvidenceCoverage(
  eventCoverage: T.QueryCoverage,
  timelineCoverage: T.QueryCoverage,
): T.QueryCoverage {
  const rank = (coverage: T.QueryCoverage): number => {
    if (!coverage.partial) return 0;
    if (coverage.partialReason === 'storage_unavailable') return 4;
    if (coverage.partialReason === 'hot_ring_only' || coverage.source === 'memory_hot_ring') return 3;
    if (coverage.partialReason === 'scan_limit') return 2;
    return 1;
  };
  return rank(timelineCoverage) > rank(eventCoverage) ? timelineCoverage : eventCoverage;
}

function markdownCell(value: unknown): string {
  const text = value == null || value === '' ? '--' : String(value);
  return redact(text).replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 220);
}

function markdownBullets(rows: Array<[string, unknown]>): string[] {
  return rows.map(([label, value]) => `- **${label}:** ${markdownCell(value)}`);
}

function markdownTable(headers: string[], rows: unknown[][]): string[] {
  if (rows.length === 0) return ['_None_'];
  return [
    `| ${headers.map(markdownCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |`),
  ];
}

function notificationRelatedIds(item: T.NotificationDeliveryItem): string {
  return [
    item.incidentId ? `incident:${item.incidentId}` : undefined,
    item.eventId ? `event:${item.eventId}` : undefined,
    item.taskId ? `task:${item.taskId}` : undefined,
    item.objectiveId ? `objective:${item.objectiveId}` : undefined,
    item.issueId ? `coverage:${item.issueId}` : undefined,
  ].filter(Boolean).join(' / ');
}

function evidenceMarkdown(bundle: T.EvidenceBundle): string {
  const lines: string[] = [
    `# AnySentry Evidence Bundle ${bundle.bundleId}`,
    '',
    ...markdownBullets([
      ['Generated', bundle.generatedAt],
      ['Primary', `${bundle.scope.primaryType}${bundle.scope.primaryId ? `:${bundle.scope.primaryId}` : ''}`],
      ['Classification View', bundle.classificationView],
      ['Review Revision', bundle.reviewRevision],
      ['Asset Binding Revision', bundle.assetBindingRevision ?? 'unavailable'],
      ['Evidence Data Source', bundle.timeline.coverage.source],
      ['Evidence Completeness', bundle.timeline.coverage.completeness ?? (bundle.timeline.coverage.partial ? 'partial' : 'exact')],
      ['Evidence Partial', bundle.timeline.coverage.partial],
      ['Evidence Partial Reason', bundle.timeline.coverage.partialReason ?? 'none'],
      ['Evidence Requested Range', `${bundle.timeline.coverage.requestedFrom} → ${bundle.timeline.coverage.requestedTo}`],
      ['Evidence Data Range', `${bundle.timeline.coverage.dataFrom ?? 'none'} → ${bundle.timeline.coverage.dataTo ?? 'none'}`],
      ['Evidence Total Mode', bundle.timeline.coverage.totalMode],
      ['Max Severity', bundle.summary.maxSeverity ?? 'none'],
      ['Events', bundle.summary.eventCount],
      ['Incidents', bundle.summary.incidentCount],
      ['Alerts', bundle.summary.alertCount],
      ['Remediations', bundle.summary.remediationCount],
      ['Objectives', bundle.summary.objectiveCount],
      ['Notification Deliveries', bundle.summary.notificationDeliveryCount],
      ['Maintenance Windows', bundle.summary.maintenanceWindowCount],
      ['Coverage Issues', bundle.summary.coverageIssueCount],
      ['Topology', `${bundle.summary.topologyNodeCount} nodes / ${bundle.summary.topologyEdgeCount} edges`],
      ['Audit Records', bundle.summary.auditCount],
      ['Agents', bundle.summary.agentCount],
      ['Workspaces', bundle.summary.workspaceCount],
      ['Sources', bundle.summary.sourceCount],
      ['Collectors', bundle.summary.collectorCount],
    ]),
    '',
    '## Scope',
    '',
    ...markdownTable(
      ['Field', 'Value'],
      Object.entries(bundle.scope).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, value]),
    ),
    '',
    '## Risk Categories',
    '',
    ...markdownTable(
      ['Risk Category', 'Risk Name', 'Events'],
      bundle.summary.riskCategories.map((item) => [item.riskCategory, item.riskName, item.eventCount]),
    ),
    '',
    '## Primary Evidence',
    '',
  ];

  if (bundle.scope.primaryType === 'notification' && bundle.primary.notificationDelivery) {
    lines.push(...markdownBullets([
      ['Type', 'Notification Delivery'],
      ['ID', bundle.primary.notificationDelivery.deliveryId],
      ['Alert', bundle.primary.notificationDelivery.alertId],
      ['Action', bundle.primary.notificationDelivery.action],
      ['Channel', bundle.primary.notificationDelivery.channelName],
      ['Route', bundle.primary.notificationDelivery.routeName ?? bundle.primary.notificationDelivery.routeId ?? 'fallback'],
      ['Status', bundle.primary.notificationDelivery.status],
      ['Related IDs', notificationRelatedIds(bundle.primary.notificationDelivery)],
    ]));
  } else if (bundle.scope.primaryType === 'maintenance' && bundle.primary.maintenanceWindow) {
    lines.push(...markdownBullets([
      ['Type', 'Maintenance Window'],
      ['ID', bundle.primary.maintenanceWindow.windowId],
      ['Title', bundle.primary.maintenanceWindow.title],
      ['Target', `${bundle.primary.maintenanceWindow.targetType}:${bundle.primary.maintenanceWindow.targetId}`],
      ['Status', bundle.primary.maintenanceWindow.status],
      ['Start', bundle.primary.maintenanceWindow.startAt],
      ['End', bundle.primary.maintenanceWindow.endAt],
      ['Owner', bundle.primary.maintenanceWindow.owner],
      ['Reason', bundle.primary.maintenanceWindow.reason],
    ]));
  } else if (bundle.scope.primaryType === 'audit' && bundle.primary.audit) {
    lines.push(...markdownBullets([
      ['Type', 'Audit Record'],
      ['ID', bundle.primary.audit.auditId],
      ['At', bundle.primary.audit.at],
      ['Actor', bundle.primary.audit.actor.displayName ?? bundle.primary.audit.actor.id],
      ['Action', bundle.primary.audit.action],
      ['Resource', `${bundle.primary.audit.resourceType}:${bundle.primary.audit.resourceId}`],
      ['Result', bundle.primary.audit.result],
      ['Summary', bundle.primary.audit.summary],
    ]));
  } else if (bundle.scope.primaryType === 'topology' && bundle.primary.topologyEdge) {
    lines.push(...markdownBullets([
      ['Type', 'Topology Edge'],
      ['ID', bundle.primary.topologyEdge.edgeId],
      ['Label', bundle.primary.topologyEdge.label],
      ['Edge Type', bundle.primary.topologyEdge.type],
      ['Sample Event', bundle.primary.topologyEdge.sampleEventId],
      ['Sample Subject', bundle.primary.topologyEdge.sampleSubject],
      ['Events', bundle.primary.topologyEdge.eventCount],
      ['Risky Events', bundle.primary.topologyEdge.riskyEventCount],
      ['Max Severity', bundle.primary.topologyEdge.maxSeverity],
    ]));
  } else if (bundle.primary.event) {
    lines.push(...markdownBullets([
      ['Type', 'Event'],
      ['ID', bundle.primary.event.eventId],
      ['Subject', bundle.primary.event.subject],
      ['Agent', bundle.primary.event.agentId],
      ['Workspace', bundle.primary.event.workspacePath],
      ['Severity', bundle.primary.event.severity],
      ['Verdict', bundle.primary.event.verdict],
      ['Reason', bundle.primary.event.reason],
    ]));
  } else if (bundle.primary.incident) {
    lines.push(...markdownBullets([
      ['Type', 'Incident'],
      ['ID', bundle.primary.incident.incidentId],
      ['Title', bundle.primary.incident.title],
      ['Status', bundle.primary.incident.status],
      ['Agent', bundle.primary.incident.agentId],
      ['Workspace', bundle.primary.incident.workspacePath],
      ['Risk', bundle.primary.incident.riskName],
      ['Description', bundle.primary.incident.description],
    ]));
  } else if (bundle.primary.alert) {
    lines.push(...markdownBullets([
      ['Type', 'Alert'],
      ['ID', bundle.primary.alert.alertId],
      ['Title', bundle.primary.alert.title],
      ['Kind', bundle.primary.alert.kind],
      ['Status', bundle.primary.alert.status],
      ['Severity', bundle.primary.alert.severity],
      ['Description', bundle.primary.alert.description],
    ]));
  } else if (bundle.primary.remediation) {
    lines.push(...markdownBullets([
      ['Type', 'Remediation'],
      ['ID', bundle.primary.remediation.taskId],
      ['Title', bundle.primary.remediation.title],
      ['Status', bundle.primary.remediation.status],
      ['Action', bundle.primary.remediation.actionKind],
      ['Recommended Action', bundle.primary.remediation.recommendedAction],
    ]));
  } else if (bundle.primary.objective) {
    lines.push(...markdownBullets([
      ['Type', 'Objective'],
      ['ID', bundle.primary.objective.objectiveId],
      ['Name', bundle.primary.objective.name],
      ['Status', bundle.primary.objective.status],
      ['Target', `${bundle.primary.objective.targetType}:${bundle.primary.objective.targetId ?? '*'}`],
      ['Metric', bundle.primary.objective.metric],
      ['Value', bundle.primary.objective.currentValue],
      ['Threshold', `${bundle.primary.objective.comparator} ${bundle.primary.objective.threshold}`],
      ['Evidence', bundle.primary.objective.evidence],
    ]));
  } else if (bundle.primary.coverageIssue) {
    lines.push(...markdownBullets([
      ['Type', 'Coverage Issue'],
      ['ID', bundle.primary.coverageIssue.issueId],
      ['Title', bundle.primary.coverageIssue.title],
      ['Severity', bundle.primary.coverageIssue.severity],
      ['Target', bundle.primary.coverageIssue.agentId ?? bundle.primary.coverageIssue.collectorId ?? bundle.primary.coverageIssue.sourceId ?? bundle.primary.coverageIssue.workspacePath],
      ['Recommended Action', bundle.primary.coverageIssue.recommendedAction],
    ]));
  } else {
	    lines.push('_Scope query only_');
	  }

  lines.push(
    '',
    '## Timeline',
    '',
    ...markdownTable(
      ['At', 'Event ID', 'Subject', 'Severity', 'Verdict'],
      bundle.timeline.items.slice(0, 30).map((event) => [event.at, event.eventId, event.subject, event.severity, event.verdict]),
    ),
    '',
    '## Incidents',
    '',
    ...markdownTable(
      ['Updated', 'Incident ID', 'Title', 'Status', 'Severity', 'Agent'],
      bundle.incidents.slice(0, 30).map((item) => [item.updatedAt, item.incidentId, item.title, item.status, item.severity, item.agentId]),
    ),
    '',
    '## Alerts',
    '',
    ...markdownTable(
      ['Last Seen', 'Alert ID', 'Title', 'Kind', 'Status', 'Severity'],
      bundle.alerts.slice(0, 30).map((item) => [item.lastSeenAt, item.alertId, item.title, item.kind, item.status, item.severity]),
    ),
    '',
    '## Remediation',
    '',
    ...markdownTable(
      ['Updated', 'Task ID', 'Title', 'Status', 'Action', 'Owner'],
      bundle.remediations.slice(0, 30).map((item) => [item.updatedAt, item.taskId, item.title, item.status, item.actionKind, item.owner]),
    ),
    '',
    '## Objectives',
    '',
    ...markdownTable(
      ['Evaluated', 'Objective ID', 'Name', 'Status', 'Target', 'Metric', 'Value', 'Threshold'],
      bundle.objectives.slice(0, 30).map((item) => [item.evaluatedAt, item.objectiveId, item.name, item.status, `${item.targetType}:${item.targetId ?? '*'}`, item.metric, item.currentValue, `${item.comparator} ${item.threshold}`]),
    ),
    '',
    '## Notification Deliveries',
    '',
    ...markdownTable(
      ['Sent', 'Delivery ID', 'Action', 'Alert ID', 'Related IDs', 'Channel', 'Route', 'Status'],
      bundle.notificationDeliveries.slice(0, 30).map((item) => [item.sentAt, item.deliveryId, item.action, item.alertId, notificationRelatedIds(item), item.channelName, item.routeName ?? item.routeId ?? 'fallback', item.status]),
    ),
    '',
    '## Maintenance Windows',
    '',
    ...markdownTable(
      ['Status', 'Window ID', 'Title', 'Target', 'Start', 'End', 'Owner'],
      bundle.maintenanceWindows.slice(0, 30).map((item) => [item.status, item.windowId, item.title, `${item.targetType}:${item.targetId}`, item.startAt, item.endAt, item.owner]),
    ),
    '',
    '## Coverage',
    '',
    ...markdownTable(
      ['Last Seen', 'Issue ID', 'Title', 'Severity', 'Target'],
      bundle.coverageIssues.slice(0, 30).map((item) => [item.lastSeenAt ?? item.detectedAt, item.issueId, item.title, item.severity, item.agentId ?? item.collectorId ?? item.sourceId ?? item.workspacePath]),
    ),
    '',
    '## Topology',
    '',
    ...markdownTable(
      ['Last Seen', 'Edge ID', 'Label', 'Events', 'Risky Events', 'Max Severity'],
      bundle.topology.edges.slice(0, 30).map((edge) => [edge.lastSeen, edge.edgeId, edge.label, edge.eventCount, edge.riskyEventCount, edge.maxSeverity]),
    ),
    '',
    '## Agents',
    '',
    ...markdownTable(
      ['Last Seen', 'Agent ID', 'Workspace', 'Health', 'Owner', 'Events', 'Open Incidents'],
      bundle.agents.slice(0, 30).map((agent) => [agent.lastSeen, agent.agentId, agent.workspacePath, agent.healthState, agent.owner, agent.eventCount, agent.openIncidentCount]),
    ),
    '',
    '## Workspaces',
    '',
    ...markdownTable(
      ['Last Seen', 'Workspace', 'Health', 'Owner', 'Agents', 'Open Incidents', 'Maintenance'],
      bundle.workspaces.slice(0, 30).map((workspace) => [workspace.lastSeen, workspace.workspacePath, workspace.healthState, workspace.owner, workspace.agentCount, workspace.openIncidentCount, workspace.maintenanceTitle ?? (workspace.maintenanceActive ? 'active' : '')]),
    ),
    '',
    '## Sources',
    '',
    ...markdownTable(
      ['Updated', 'Source ID', 'Name', 'Type', 'Status', 'Collector'],
      bundle.sources.slice(0, 30).map((source) => [source.updatedAt, source.sourceId, source.name, source.type, source.status, source.collectorId]),
    ),
    '',
    '## Collectors',
    '',
    ...markdownTable(
      ['Last Seen', 'Collector ID', 'Node', 'State', 'Events', 'Errors'],
      bundle.collectors.slice(0, 30).map((collector) => [collector.lastSeenAt ?? collector.lastHeartbeatAt, collector.collectorId, collector.nodeName, collector.stateText, collector.eventCount, collector.errorCount]),
    ),
    '',
    '## Audit Trail',
    '',
    ...markdownTable(
      ['At', 'Audit ID', 'Actor', 'Resource', 'Action', 'Result', 'Summary'],
      bundle.audits.slice(0, 50).map((audit) => [audit.at, audit.auditId, audit.actor.displayName ?? audit.actor.id, `${audit.resourceType}:${audit.resourceId}`, audit.action, audit.result, audit.summary]),
    ),
    '',
  );

  return lines.join('\n');
}

function cleanString(value: unknown, limit: number): string | undefined {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  return text ? redact(text).slice(0, limit) : undefined;
}

/**
 * Correlation identifiers are identity material, not display text. Never coerce, redact, or
 * truncate them: doing so could collapse two distinct producer claims into one trusted identity.
 * Invalid values are omitted from the public EventMeta while the raw value is passed separately
 * to the trusted resolver so it can emit an `invalid_claim` receipt.
 */
function strictIdentityText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > limit || /[\u0000-\u001f\u007f]/u.test(text)) return undefined;
  return text;
}

function validCorrelationClaimText(value: unknown): string | undefined {
  return strictIdentityText(value, 512);
}

function canonicalCollectorId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  // Collector IDs are protocol identities, not display text. Redacting only one side of an
  // identity comparison would change the principal and could bind a heartbeat to the wrong Source.
  return text && text.length <= 180 && !/[\u0000-\u001f\u007f]/u.test(text) ? text : undefined;
}

function isTrustedCollectorProducer(
  resolution: IngestionSourceResolution,
  collectorId: unknown,
): boolean {
  const source = resolution.source;
  const sourceCollectorId = canonicalCollectorId(source?.collectorId);
  const eventCollectorId = canonicalCollectorId(collectorId);
  return Boolean(
    resolution.authenticated &&
    source?.requireToken &&
    !source.discovered &&
    (source.type === 'observer' || source.type === 'forwarder') &&
    sourceCollectorId &&
    sourceCollectorId === eventCollectorId,
  );
}

function isTrustedSystemContextProducer(
  resolution: IngestionSourceResolution,
  eventWorkspacePath: string | undefined,
): boolean {
  const source = resolution.source;
  const boundWorkspacePath = source?.workspacePath?.trim();
  return Boolean(
    resolution.authenticated &&
    source?.enabled &&
    source.requireToken &&
    !source.discovered &&
    source.tags.includes('system-context') &&
    Boolean(boundWorkspacePath) &&
    boundWorkspacePath === eventWorkspacePath,
  );
}

function observerLineEventKind(line: string): string | undefined {
  try {
    const event = obj(obj(JSON.parse(line))?.event);
    const keys = event ? Object.keys(event) : [];
    return keys.length === 1 ? cleanString(keys[0], 80) : undefined;
  } catch {
    return undefined;
  }
}

function trustedUnknownReasonMetrics(
  metrics: T.CollectorFilterMetrics | undefined,
  trusted: boolean,
): T.CollectorFilterMetrics | undefined {
  if (!metrics || trusted || !metrics.unknownReasonCounts) return metrics;
  const { unknownReasonCounts: _untrustedUnknownReasons, ...legacyMetrics } = metrics;
  return legacyMetrics;
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function integerField(event: T.UniversalIngestEvent, key: keyof T.UniversalIngestEvent): number | undefined {
  const n = finiteNumber(event[key]);
  return n === undefined ? undefined : Math.round(n);
}

function eventAttr(event: T.UniversalIngestEvent, key: string): unknown {
  const attrs = obj(event.attributes);
  return (event as Record<string, unknown>)[key] ?? attrs?.[key];
}

function argvField(event: T.UniversalIngestEvent): string[] | undefined {
  const direct = event.command ?? event.argv ?? eventAttr(event, 'argv') ?? eventAttr(event, 'command');
  if (Array.isArray(direct)) {
    const argv: string[] = [];
    let remaining = 32_768;
    for (const item of direct.slice(0, 128)) {
      if (typeof item !== 'string' || remaining <= 0) continue;
      const arg = redact(item).slice(0, Math.min(8_192, remaining));
      argv.push(arg);
      remaining -= arg.length;
    }
    return argv.length ? argv : undefined;
  }
  const text = cleanString(direct, 600);
  if (!text) return undefined;
  return text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, '')).slice(0, 80) ?? [text];
}

function sanitizeEventAttributes(value: unknown): Record<string, T.EventAttributeValue> {
  const input = obj(value);
  if (!input) return {};
  const out: Record<string, T.EventAttributeValue> = {};
  for (const [key, raw] of Object.entries(input).slice(0, 120)) {
    const cleanKey = cleanString(key, 80);
    if (!cleanKey) continue;
    const v = attrValue(raw, cleanKey);
    if (v !== undefined) out[cleanKey] = v;
  }
  return out;
}

function canonicalEventKind(input: T.UniversalIngestEvent): string {
  const raw = cleanString(input.eventKind ?? input.kind ?? eventAttr(input, 'eventKind') ?? eventAttr(input, 'kind'), 80);
  const key = raw?.toLowerCase().replace(/[\s.-]+/g, '_');
  const aliases: Record<string, string> = {
    tool: 'ToolExec',
    exec: 'ToolExec',
    command: 'ToolExec',
    tool_exec: 'ToolExec',
    toolexec: 'ToolExec',
    agent_tool: 'AgentTool',
    agenttool: 'AgentTool',
    tool_call: 'AgentTool',
    toolcall: 'AgentTool',
    function_call: 'AgentTool',
    functioncall: 'AgentTool',
    execute_tool: 'AgentTool',
    agent_invocation: 'AgentInvocation',
    agentinvocation: 'AgentInvocation',
    invoke_agent: 'AgentInvocation',
    user_message: 'UserMessage',
    usermessage: 'UserMessage',
    user_input: 'UserMessage',
    human_message: 'UserMessage',
    assistant_message: 'ModelMessage',
    model_message: 'ModelMessage',
    assistant_output: 'ModelMessage',
    final_response: 'ModelMessage',
    tool_result: 'ToolResult',
    toolresult: 'ToolResult',
    function_result: 'ToolResult',
    agent_tool_result: 'ToolResult',
    node: 'NodeRun',
    node_run: 'NodeRun',
    noderun: 'NodeRun',
    workflow_node: 'NodeRun',
    workflownode: 'NodeRun',
    workflowrun: 'AgentInvocation',
    workflow_run: 'AgentInvocation',
    agent_run: 'AgentInvocation',
    llm_response: 'LlmResponse',
    model_response: 'LlmResponse',
    egress: 'Egress',
    network: 'Egress',
    network_egress: 'Egress',
    networkegress: 'Egress',
    egress_event: 'Egress',
    http: 'Egress',
    dns: 'Dns',
    file: 'FileAccess',
    file_access: 'FileAccess',
    fileaccess: 'FileAccess',
    file_read: 'FileAccess',
    fileread: 'FileAccess',
    read_file: 'FileAccess',
    file_write: 'FileAccess',
    filewrite: 'FileAccess',
    write_file: 'FileAccess',
    file_delete: 'FileDelete',
    filedelete: 'FileDelete',
    llm: 'LlmCall',
    llm_call: 'LlmCall',
    llmcall: 'LlmCall',
    llm_api: 'LlmApi',
    llmapi: 'LlmApi',
    llm_interaction: 'LlmInteraction',
    llminteraction: 'LlmInteraction',
    agent_plaintext_evidence: 'AgentPlaintextEvidence',
    agentplaintextevidence: 'AgentPlaintextEvidence',
    ssl: 'SslContent',
    ssl_content: 'SslContent',
    sslcontent: 'SslContent',
    security: 'SecurityAction',
    security_action: 'SecurityAction',
    securityaction: 'SecurityAction',
    security_finding: 'SecurityAction',
    securityfinding: 'SecurityAction',
    finding: 'SecurityAction',
    alert: 'SecurityAction',
    risk: 'SecurityAction',
    process: 'ProcessExit',
    process_exit: 'ProcessExit',
    processexit: 'ProcessExit',
    runtime: 'RuntimeEvent',
    runtime_event: 'RuntimeEvent',
    runtimeevent: 'RuntimeEvent',
    system_context: 'SystemContext',
    systemcontext: 'SystemContext',
    verifier_warning: 'RuntimeEvent',
    verifierwarning: 'RuntimeEvent',
  };
  if (key && aliases[key]) return aliases[key];
  if (raw) return raw;
  if (argvField(input)?.length) return 'ToolExec';
  if (cleanString(input.path ?? eventAttr(input, 'path'), 500)) return 'FileAccess';
  if (cleanString(input.query ?? eventAttr(input, 'query'), 500)) return 'Dns';
  if (cleanString(input.endpoint ?? input.sni ?? eventAttr(input, 'endpoint') ?? eventAttr(input, 'sni'), 500)) return 'LlmCall';
  if (cleanString(input.peer ?? eventAttr(input, 'peer'), 500)) return 'Egress';
  return 'Event';
}

function eventInner(kind: string, input: T.UniversalIngestEvent): Record<string, unknown> {
  const pid = integerField(input, 'pid') ?? finiteNumber(eventAttr(input, 'pid')) ?? 1;
  const uid = integerField(input, 'uid') ?? finiteNumber(eventAttr(input, 'uid'));
  const cwd = cleanString(input.cwd ?? eventAttr(input, 'cwd'), 500);
  const base = {
    pid,
    ...(uid !== undefined ? { uid } : {}),
    ...(cwd ? { cwd } : {}),
  };
  if (kind === 'ToolExec') {
    return {
      ...base,
      argv: argvField(input) ?? ['unknown'],
      argv_truncated: eventAttr(input, 'argv_truncated') === true,
      argv_incomplete: eventAttr(input, 'argv_incomplete') === true,
    };
  }
  if (kind === 'Egress') {
    const peer = sanitizeEndpointAttributeValue(
      cleanString(input.peer ?? input.endpoint ?? eventAttr(input, 'peer') ?? eventAttr(input, 'endpoint'), 500) ?? 'unknown',
      'peer',
    );
    const port = finiteNumber(input.port ?? eventAttr(input, 'port'));
    return { ...base, peer, ...(port !== undefined ? { port } : {}) };
  }
  if (kind === 'Dns') return { ...base, query: cleanString(input.query ?? input.peer ?? input.endpoint ?? eventAttr(input, 'query'), 500) ?? 'unknown' };
  if (kind === 'FileAccess' || kind === 'FileDelete') return { ...base, path: cleanString(input.path ?? eventAttr(input, 'path'), 800) ?? 'unknown' };
  if (kind === 'LlmCall') {
    const endpoint = sanitizeEndpointAttributeValue(
      cleanString(input.sni ?? input.endpoint ?? input.peer ?? eventAttr(input, 'sni') ?? eventAttr(input, 'endpoint'), 500) ?? 'llm',
      'endpoint',
    );
    return { ...base, sni: endpoint, peer: endpoint };
  }
  if (kind === 'LlmApi') {
    const endpoint = sanitizeEndpointAttributeValue(
      cleanString(input.sni ?? input.endpoint ?? input.peer ?? eventAttr(input, 'sni') ?? eventAttr(input, 'endpoint'), 500) ?? 'llm',
      'endpoint',
    );
    return {
      ...base,
      sni: endpoint,
      peer: endpoint,
      prompt_tokens: finiteNumber(input.promptTokens ?? eventAttr(input, 'prompt_tokens') ?? eventAttr(input, 'promptTokens')) ?? 0,
      completion_tokens: finiteNumber(input.completionTokens ?? eventAttr(input, 'completion_tokens') ?? eventAttr(input, 'completionTokens')) ?? 0,
    };
  }
  if (kind === 'SslContent') return { ...base, content: cleanString(input.content ?? input.data ?? eventAttr(input, 'content') ?? eventAttr(input, 'data'), 1000) ?? '' };
  if (kind === 'SecurityAction') return { ...base, kind: cleanString(input.kind ?? input.status ?? eventAttr(input, 'kind') ?? eventAttr(input, 'status'), 240) ?? 'security' };
  if (kind === 'RuntimeEvent') {
    return {
      ...base,
      kind: cleanString(input.runtimeKind ?? input.status ?? eventAttr(input, 'runtimeKind') ?? eventAttr(input, 'progressive.warning'), 240) ?? 'runtime',
    };
  }
  if (isSemanticUniversalEventKind(kind)) {
    const semanticValue = input.content ?? input.data ?? input.raw
      ?? input.subject ?? eventAttr(input, 'content') ?? eventAttr(input, 'data');
    const serialized = typeof semanticValue === 'string'
      ? semanticValue
      : semanticValue === undefined ? '' : JSON.stringify(semanticValue) ?? '';
    const payload = Buffer.from(serialized, 'utf8');
    return {
      ...base,
      payload_sha256: safePayloadDigest(semanticValue),
      payload_bytes: payload.length,
      ...(cleanString(input.toolCallId ?? eventAttr(input, 'toolCallId') ?? eventAttr(input, 'tool_call_id'), 512)
        ? { tool_call_id: cleanString(input.toolCallId ?? eventAttr(input, 'toolCallId') ?? eventAttr(input, 'tool_call_id'), 512) }
        : {}),
      ...(cleanString(input.runId ?? eventAttr(input, 'runId') ?? eventAttr(input, 'run_id'), 512)
        ? { run_id: cleanString(input.runId ?? eventAttr(input, 'runId') ?? eventAttr(input, 'run_id'), 512) }
        : {}),
      ...(cleanString(input.status, 120) ? { status: cleanString(input.status, 120) } : {}),
    };
  }
  if (kind === 'ProcessExit') {
    const exitCode = finiteNumber(
      input.exitCode
      ?? input.exit_code
      ?? input.status
      ?? eventAttr(input, 'exit_code')
      ?? eventAttr(input, 'exitCode')
      ?? eventAttr(input, 'status'),
    );
    const signal = finiteNumber(input.signal ?? eventAttr(input, 'signal'));
    return {
      ...base,
      ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };
  }
  const safeAttributes = sanitizeEventAttributes(input.attributes);
  const semanticSensitive = /^(?:body|content|prompt|input|output|messages?|arguments?|result|response)$/iu;
  for (const key of Object.keys(safeAttributes)) {
    if (!semanticSensitive.test(key)) continue;
    const raw = safeAttributes[key];
    const value = String(raw);
    safeAttributes[`${key}_sha256`] = createHash('sha256').update(value).digest('hex');
    delete safeAttributes[key];
  }
  return { ...base, ...safeAttributes };
}

function universalEventLine(kind: string, input: T.UniversalIngestEvent, defaults: T.UniversalIngestRequest): string {
  const agent = cleanString(input.agentId ?? defaults.agentId, 240) ?? 'api-agent';
  const session = cleanString(input.sessionId ?? defaults.sessionId, 240);
  const task = cleanString(input.taskId ?? defaults.taskId, 240);
  const identity = { agent, ...(session ? { session } : {}), ...(task ? { task } : {}) };
  const suppliedProcess = input.process;
  const pid = integerField(input, 'pid')
    ?? finiteNumber(eventAttr(input, 'pid'))
    ?? suppliedProcess?.pid;
  const ppid = finiteNumber((input as Record<string, unknown>).ppid ?? eventAttr(input, 'ppid'))
    ?? suppliedProcess?.ppid;
  const process = pid !== undefined
    ? {
        pid,
        ...(ppid !== undefined ? { ppid } : {}),
        ...(cleanString(input.cwd ?? suppliedProcess?.cwd ?? eventAttr(input, 'cwd'), 500) ? { cwd: cleanString(input.cwd ?? suppliedProcess?.cwd ?? eventAttr(input, 'cwd'), 500) } : {}),
        ...(cleanString(suppliedProcess?.hostId ?? eventAttr(input, 'hostId') ?? eventAttr(input, 'host_id'), 240) ? { hostId: cleanString(suppliedProcess?.hostId ?? eventAttr(input, 'hostId') ?? eventAttr(input, 'host_id'), 240) } : {}),
        ...(cleanString(suppliedProcess?.bootId ?? eventAttr(input, 'bootId') ?? eventAttr(input, 'boot_id'), 240) ? { bootId: cleanString(suppliedProcess?.bootId ?? eventAttr(input, 'bootId') ?? eventAttr(input, 'boot_id'), 240) } : {}),
        ...(cleanString(suppliedProcess?.startTimeTicks ?? eventAttr(input, 'startTimeTicks') ?? eventAttr(input, 'start_time_ticks'), 64) ? { startTimeTicks: cleanString(suppliedProcess?.startTimeTicks ?? eventAttr(input, 'startTimeTicks') ?? eventAttr(input, 'start_time_ticks'), 64) } : {}),
        ...(cleanString(suppliedProcess?.startTimeNs ?? eventAttr(input, 'startTimeNs') ?? eventAttr(input, 'start_time_ns'), 64) ? { startTimeNs: cleanString(suppliedProcess?.startTimeNs ?? eventAttr(input, 'startTimeNs') ?? eventAttr(input, 'start_time_ns'), 64) } : {}),
      }
    : undefined;
  const eventAt = eventTime(input);
  const eventAtUnixNs = Number.isFinite(eventAt) && eventAt > 0
    ? (BigInt(Math.trunc(eventAt)) * 1_000_000n).toString()
    : undefined;
  const receivedAtUnixNs = (BigInt(Date.now()) * 1_000_000n).toString();
  // Keep the line replayable without copying arbitrary producer bodies into the canonical raw
  // lane. IDs and a digest provide provenance; semantic payloads remain in the existing bounded
  // compatibility fields/attributes and are subject to their normal redaction policy.
  const provenance = {
    ...(eventAtUnixNs ? { eventAtUnixNs } : {}),
    receivedAtUnixNs,
    ...(cleanString(input.sourceEventId ?? input.id, 240) ? { sourceEventId: cleanString(input.sourceEventId ?? input.id, 240) } : {}),
    ...(cleanString(input.traceId ?? defaults.traceId, 240) ? { traceId: cleanString(input.traceId ?? defaults.traceId, 240) } : {}),
    ...(cleanString(input.invocationId ?? defaults.invocationId, 240) ? { invocationId: cleanString(input.invocationId ?? defaults.invocationId, 240) } : {}),
    ...(cleanString(input.toolCallId ?? defaults.toolCallId, 240) ? { toolCallId: cleanString(input.toolCallId ?? defaults.toolCallId, 240) } : {}),
    ...(cleanString(input.runId ?? defaults.runId, 240) ? { runId: cleanString(input.runId ?? defaults.runId, 240) } : {}),
  };
  return JSON.stringify({
    identity,
    ...(process ? { process } : {}),
    ...provenance,
    event: { [kind]: eventInner(kind, input) },
  });
}

function hasTopLevelEventShape(body: T.UniversalIngestRequest): boolean {
  return Boolean(
    body.eventKind ||
      (body as { kind?: unknown }).kind ||
      body.subject ||
      body.attributes ||
      (body as { argv?: unknown }).argv ||
      (body as { command?: unknown }).command ||
      (body as { peer?: unknown }).peer ||
      (body as { endpoint?: unknown }).endpoint ||
      (body as { query?: unknown }).query ||
      (body as { path?: unknown }).path,
  );
}

function universalEvents(body: T.UniversalIngestRequest): T.UniversalIngestEvent[] {
  if (Array.isArray(body.events)) return body.events.slice(0, 500);
  if (body.event) return [body.event];
  return hasTopLevelEventShape(body) ? [body as T.UniversalIngestEvent] : [];
}

function eventTime(input: T.UniversalIngestEvent): number {
  const raw = input.at ?? input.timestamp ?? eventAttr(input, 'timestamp');
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 10_000_000_000 ? raw : raw * 1000;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n > 10_000_000_000 ? n : n * 1000;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function cloudEventHeader(headers: HeaderBag | undefined, name: string): string | undefined {
  return headerValue(headers, `ce-${name}`);
}

function invalidCloudEventDataBase64(): Record<string, unknown> {
  return {
    kind: 'invalid',
    subject: 'invalid CloudEvents data_base64',
    attributes: { invalidCloudEventDataBase64: true },
  };
}

function validBase64Text(value: string): string | undefined {
  const compact = value.replace(/\s+/g, '');
  if (!compact) return '';
  if (compact.length % 4 === 1 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact)) return undefined;
  const normalizedInput = compact.replace(/=+$/, '');
  const padded = compact.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(compact.length / 4) * 4, '=');
  const decoded = Buffer.from(padded, 'base64');
  const normalizedStandard = decoded.toString('base64').replace(/=+$/, '');
  const normalizedUrlSafe = normalizedStandard.replace(/\+/g, '-').replace(/\//g, '_');
  if (normalizedInput !== normalizedStandard && normalizedInput !== normalizedUrlSafe) return undefined;
  const text = decoded.toString('utf8');
  return Buffer.from(text, 'utf8').equals(decoded) ? text : undefined;
}

function cloudEventBase64Data(body: T.UniversalIngestRequest & Record<string, unknown>): Record<string, unknown> | undefined {
  if (body.data_base64 === undefined) return undefined;
  if (typeof body.data_base64 !== 'string') return invalidCloudEventDataBase64();
  const decoded = validBase64Text(body.data_base64);
  if (decoded === undefined) return invalidCloudEventDataBase64();
  if (!decoded.trim()) return {};
  try {
    const parsed = JSON.parse(decoded);
    const parsedObj = obj(parsed);
    if (parsedObj) return parsedObj;
    return { data: cleanString(parsed, 1_000) ?? decoded.slice(0, 1_000) };
  } catch {
    return { data: redact(decoded).slice(0, 1_000) };
  }
}

function cloudEventData(body: T.UniversalIngestRequest & Record<string, unknown>, headers?: HeaderBag): Record<string, unknown> {
  if (isBinaryCloudEvent(headers)) {
    const data = { ...body };
    for (const key of ['sourceId', 'sourceName', 'sourceType', 'token', 'collectorId', 'nodeName']) delete data[key];
    return data;
  }
  const data = obj(body.data);
  if (data) return data;
  if (typeof body.data === 'string' && body.data.trim()) {
    try {
      const parsed = JSON.parse(body.data);
      return obj(parsed) ?? { data: body.data };
    } catch {
      return { data: body.data };
    }
  }
  const base64Data = cloudEventBase64Data(body);
  if (base64Data) return base64Data;
  return {};
}

function isStructuredCloudEvent(body: T.UniversalIngestRequest & Record<string, unknown>): boolean {
  return Boolean((typeof body.specversion === 'string' || typeof body.specVersion === 'string') && typeof body.type === 'string' && body.type.trim());
}

function isBinaryCloudEvent(headers: HeaderBag | undefined): boolean {
  return Boolean(cloudEventHeader(headers, 'specversion') && cloudEventHeader(headers, 'type'));
}

function isCloudEvent(body: T.UniversalIngestRequest & Record<string, unknown>, headers?: HeaderBag): boolean {
  return isStructuredCloudEvent(body) || isBinaryCloudEvent(headers);
}

function cloudEventTime(...values: unknown[]): string | number | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function cloudEventKind(type: string, data: Record<string, unknown>): string {
  const explicit = cleanString(data.eventKind ?? data.kind ?? data['anysentry.event.kind'], 120);
  if (explicit) return explicit;
  const lower = type.toLowerCase();
  if (lower.includes('tool') || lower.includes('exec') || lower.includes('command')) return 'tool';
  if (lower.includes('egress') || lower.includes('network') || lower.includes('http')) return 'egress';
  if (lower.includes('dns')) return 'dns';
  if (lower.includes('file') || lower.includes('artifact')) return 'file';
  if (lower.includes('llm') || lower.includes('ai') || lower.includes('model')) return 'llm';
  if (lower.includes('security') || lower.includes('policy')) return 'security';
  if (lower.includes('process')) return 'process';
  return type.split('.').filter(Boolean).at(-1) ?? type;
}

function cloudEventEnvelope(body: T.UniversalIngestRequest & Record<string, unknown>, headers?: HeaderBag): Record<string, unknown> {
  if (!isBinaryCloudEvent(headers)) return body;
  const envelope: Record<string, unknown> = {
    ...body,
    specversion: cloudEventHeader(headers, 'specversion'),
    id: cloudEventHeader(headers, 'id'),
    type: cloudEventHeader(headers, 'type'),
    source: cloudEventHeader(headers, 'source'),
    subject: cloudEventHeader(headers, 'subject'),
    time: cloudEventHeader(headers, 'time'),
    datacontenttype: cloudEventHeader(headers, 'datacontenttype') ?? headerValue(headers, 'content-type'),
    dataschema: cloudEventHeader(headers, 'dataschema'),
  };
  return envelope;
}

function cloudEventHeaderAttributes(headers: HeaderBag | undefined): Record<string, T.EventAttributeValue> {
  const attrs: Record<string, T.EventAttributeValue> = {};
  if (!headers) return attrs;
  const reserved = new Set(['ce-specversion', 'ce-id', 'ce-type', 'ce-source', 'ce-subject', 'ce-time', 'ce-datacontenttype', 'ce-dataschema']);
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (!key.startsWith('ce-') || reserved.has(key)) continue;
    const value = Array.isArray(rawValue) ? rawValue.find(Boolean) : rawValue;
    const extension = key.slice(3);
    const attr = attrValue(value, extension);
    if (attr !== undefined) attrs[`cloudevents.${extension}`] = attr;
  }
  return attrs;
}

function cloudEventAttributes(body: T.UniversalIngestRequest & Record<string, unknown>, data: Record<string, unknown>, headers?: HeaderBag): Record<string, T.EventAttributeValue> {
  const reserved = new Set([
    'specversion',
    'specVersion',
    'id',
    'type',
    'source',
    'subject',
    'time',
    'data',
    'data_base64',
    'datacontenttype',
    'dataschema',
    'sourceId',
    'sourceName',
    'sourceType',
    'token',
    'collectorId',
    'nodeName',
    'workspacePath',
    'agentId',
    'sessionId',
    'userId',
    'traceId',
    'spanId',
    'parentSpanId',
    'runId',
    'taskId',
    'eventKind',
    'eventCategory',
  ]);
  const extensions: Record<string, T.EventAttributeValue> = {};
  for (const [key, value] of Object.entries(body)) {
    if (reserved.has(key)) continue;
    const attr = attrValue(value, key);
    if (attr !== undefined) extensions[`cloudevents.${key}`] = attr;
  }
  return {
    ...cloudEventHeaderAttributes(headers),
    ...extensions,
    ...sanitizeEventAttributes(data.attributes),
    cloudEventId: cleanString(body.id, 240) ?? '',
    cloudEventType: cleanString(body.type, 240) ?? '',
    cloudEventSource: cleanString(body.source, 500) ?? '',
    cloudEventSpecVersion: cleanString(body.specversion ?? body.specVersion, 40) ?? '',
    ...(body.dataschema ? { cloudEventDataSchema: cleanString(body.dataschema, 500) ?? '' } : {}),
    ...(body.datacontenttype ? { cloudEventContentType: cleanString(body.datacontenttype, 120) ?? '' } : {}),
    ...(body.data_base64 ? { cloudEventDataBase64: true } : {}),
  };
}

function normalizeCloudEvent(body: T.UniversalIngestRequest & Record<string, unknown>, headers?: HeaderBag): T.UniversalIngestRequest {
  if (!isCloudEvent(body, headers)) return body;
  const envelope = cloudEventEnvelope(body, headers);
  const data = cloudEventData(body, headers);
  const type = cleanString(envelope.type, 240) ?? 'cloudevent';
  const sourceName = cleanString(body.sourceName ?? data.sourceName ?? envelope.source, 180);
  const event: T.UniversalIngestEvent = {
    ...data,
    kind: cloudEventKind(type, data),
    at: cloudEventTime(data.at, data.timestamp, envelope.time),
    agentId: cleanString(data.agentId ?? data.agent ?? body.agentId ?? envelope.subject, 240),
    workspacePath: cleanString(data.workspacePath ?? data.workspace ?? body.workspacePath ?? envelope.source, 500),
    sessionId: cleanString(data.sessionId ?? data.session ?? body.sessionId ?? envelope.id, 240),
    userId: cleanString(data.userId ?? data.user ?? body.userId, 240),
    traceId: cleanString(data.traceId ?? data.traceparent ?? body.traceId ?? body.traceparent, 240),
    spanId: cleanString(data.spanId ?? body.spanId, 240),
    runId: cleanString(data.runId ?? body.runId ?? envelope.id, 240),
    taskId: cleanString(data.taskId ?? body.taskId, 240),
    subject: cleanString(data.subject ?? envelope.subject ?? type, 500),
    rawPreview: sanitizeRawPreview({ ...envelope, token: undefined }),
    attributes: cloudEventAttributes(envelope, data, headers),
  };
  bindRawUniversalCorrelationClaims(event, {
    invocationId: data.invocationId ?? body.invocationId,
    toolCallId: data.toolCallId ?? body.toolCallId,
    traceId: data.traceId ?? data.traceparent ?? body.traceId ?? body.traceparent,
    sessionId: data.sessionId ?? data.session ?? body.sessionId ?? envelope.id,
    workspacePath: data.workspacePath
      ?? data.workspace
      ?? body.workspacePath
      ?? envelope.source
      ?? data.cwd
      ?? rawAttributeValue(data.attributes, 'cwd')
      ?? rawAgentWorkspace(data.agentId ?? data.agent ?? body.agentId ?? envelope.subject),
    collectorId: data.collectorId ?? data.collector ?? body.collectorId,
    attributes: {
      ...rawNormalizedEventAttributes(body.attributes),
      ...rawNormalizedEventAttributes(data.attributes),
    },
    attribution: data.attribution ?? body.attribution,
  });
  return {
    ...body,
    sourceName,
    sourceType: body.sourceType ?? 'webhook',
    collectorId: body.collectorId ?? cleanString(data.collectorId ?? data.collector, 180),
    workspacePath: event.workspacePath ?? body.workspacePath,
    agentId: event.agentId ?? body.agentId,
    sessionId: event.sessionId ?? body.sessionId,
    traceId: event.traceId ?? body.traceId,
    event,
  };
}

function normalizeUniversalIngestBody(body: T.UniversalIngestBody | undefined, headers?: HeaderBag): T.UniversalIngestRequest {
  if (Array.isArray(body)) {
    const records = body.slice(0, 500).map((item) => obj(item));
    const first = records.find((item): item is T.UniversalIngestRequest & Record<string, unknown> => Boolean(item));
    const events = records.flatMap((record) => {
      if (!record) return [{ kind: 'invalid', subject: 'invalid batch item', attributes: { invalidBatchItem: true } }];
      const item = normalizeCloudEvent(record as T.UniversalIngestRequest & Record<string, unknown>);
      return item.event
        ? [mergeRawUniversalCorrelationClaimDefaults(item.event, {
            collectorId: first?.collectorId,
            workspacePath: first?.workspacePath,
          })]
        : universalEvents(item);
    });
    return {
      sourceId: first?.sourceId,
      sourceName: first?.sourceName,
      sourceType: first?.sourceType ?? 'webhook',
      token: first?.token,
      collectorId: first?.collectorId,
      workspacePath: first?.workspacePath,
      events,
    };
  }
  return normalizeCloudEvent((body ?? {}) as T.UniversalIngestRequest & Record<string, unknown>, headers);
}

function universalEventCollectorId(input: T.UniversalIngestEvent, defaults: T.UniversalIngestRequest): string | undefined {
  return cleanString(input.collectorId ?? eventAttr(input, 'collectorId') ?? defaults.collectorId, 180);
}

function universalEventNodeName(input: T.UniversalIngestEvent, defaults: T.UniversalIngestRequest): string | undefined {
  return cleanString(input.nodeName ?? eventAttr(input, 'collectorNode') ?? eventAttr(input, 'nodeName') ?? defaults.nodeName, 180);
}

function universalMeta(input: T.UniversalIngestEvent, defaults: T.UniversalIngestRequest, sourceId: string | undefined): Partial<T.EventMeta> {
  const collectorId = universalEventCollectorId(input, defaults);
  const collectorNode = universalEventNodeName(input, defaults);
  const attrs: Record<string, T.EventAttributeValue> = {
    ...sanitizeEventAttributes(defaults.attributes),
    ...sanitizeEventAttributes(input.attributes),
    ...(collectorId ? { collectorId } : {}),
    ...(collectorNode ? { collectorNode } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(defaults.sourceType ? { sourceType: defaults.sourceType } : {}),
  };
  return {
    workspacePath: cleanString(input.workspacePath ?? defaults.workspacePath, 500),
    agentId: cleanString(input.agentId ?? defaults.agentId, 240),
    sessionId: cleanString(input.sessionId ?? defaults.sessionId, 240),
    userId: cleanString(input.userId ?? defaults.userId, 240),
    source: input.source ?? defaults.source ?? 'api',
    eventCategory: input.eventCategory ?? input.category ?? defaults.eventCategory,
    traceId: cleanString(input.traceId ?? defaults.traceId, 240),
    invocationId: validCorrelationClaimText(input.invocationId ?? defaults.invocationId),
    toolCallId: validCorrelationClaimText(input.toolCallId ?? defaults.toolCallId),
    spanId: cleanString(input.spanId ?? defaults.spanId, 240),
    parentSpanId: cleanString(input.parentSpanId ?? defaults.parentSpanId, 240),
    runId: cleanString(input.runId ?? defaults.runId, 240),
    turnId: cleanString(input.turnId ?? defaults.turnId ?? eventAttr(input, 'turnId') ?? eventAttr(input, 'turn_id'), 240),
    runIdSource: input.runId !== undefined || defaults.runId !== undefined ? 'producer' : undefined,
    logicalAgentId: cleanString(input.logicalAgentId ?? defaults.logicalAgentId, 240),
    logicalDefinitionId: cleanString(input.logicalDefinitionId ?? defaults.logicalDefinitionId, 240),
    logicalScopeMode: input.logicalScopeMode ?? defaults.logicalScopeMode,
    tenantId: cleanString(input.tenantId ?? defaults.tenantId, 240),
    ownerId: cleanString(input.ownerId ?? defaults.ownerId, 240),
    profile: cleanString(input.profile ?? defaults.profile, 240),
    profileVersion: cleanString(input.profileVersion ?? defaults.profileVersion, 120),
    deploymentId: cleanString(input.deploymentId ?? defaults.deploymentId, 240),
    deploymentRevision: cleanString(input.deploymentRevision ?? defaults.deploymentRevision, 120),
    environmentId: cleanString(input.environmentId ?? defaults.environmentId, 240),
    terminalContextId: cleanString(input.terminalContextId ?? defaults.terminalContextId, 240),
    taskId: cleanString(input.taskId ?? defaults.taskId, 240),
    subject: cleanString(input.subject ?? defaults.subject, 500),
    tokenCount: finiteNumber(input.tokenCount ?? defaults.tokenCount),
    latencyMs: finiteNumber(input.latencyMs ?? defaults.latencyMs),
    rawPreview: sanitizeRawPreview(input.rawPreview ?? defaults.rawPreview),
    sourceEventId: cleanString(
      input.sourceEventId
        ?? input.id
        ?? eventAttr(input, 'sourceEventId')
        ?? eventAttr(input, 'cloudEventId'),
      240,
    ),
    attributes: attrs,
  };
}

/**
 * Resolve a universal/OTLP event's Session at the authenticated server boundary.  Generic
 * producers may report a provider conversation/thread identifier, but they never get to provide
 * the canonical HMAC key or promote a runtime/container id.  This keeps application events on the
 * same Session contract as parsed Observer interactions without adding product branches.
 */
function bindUniversalSessionIdentity(
  meta: T.EventMeta,
  input: T.UniversalIngestEvent,
  defaults: T.UniversalIngestRequest,
  options: { ignoreMetaSessionFallback?: boolean; allowProviderAnchor?: boolean } = {},
): T.EventMeta {
  const attr = (...keys: string[]): unknown => {
    for (const key of keys) {
      const direct = input.attributes?.[key] ?? defaults.attributes?.[key];
      if (direct !== undefined) return direct;
    }
    return undefined;
  };
  const explicitSessionId = input.sessionId
    ?? defaults.sessionId
    ?? attr(
      'anysentry.session.id',
      'gen_ai.conversation.id',
      'conversation.id',
      'conversation_id',
      'thread.id',
      'thread_id',
      'session.id',
    );
  const rawSessionId = strictIdentityText(
    explicitSessionId
      // A derived EventMeta session is only safe to reuse when an upstream provider explicitly
      // marked it as such. Service/Pod/runtime IDs are intentionally never a Session fallback.
      ?? (!options.ignoreMetaSessionFallback
        && (meta.sessionIdSource === 'provider' || meta.sessionIdSource === 'authenticated_adapter')
        ? meta.sessionId : undefined),
    512,
  );
  const providerClaimPresent = Boolean(
    input.providerSessionId
      ?? input.conversationId
      ?? input.threadId
      ?? ((input.sessionIdSource === 'provider' || input.sessionIdSource === 'authenticated_adapter')
        ? rawSessionId : undefined)
      ?? ((defaults.sessionIdSource === 'provider' || defaults.sessionIdSource === 'authenticated_adapter')
        ? rawSessionId : undefined)
      ?? attr(
        'providerSessionId', 'provider_session_id', 'conversationId', 'conversation_id',
        'threadId', 'thread_id', 'anysentry.session.id', 'gen_ai.conversation.id',
        'conversation.id', 'session.id',
      ),
  );
  const untrustedProviderClaim = options.allowProviderAnchor === false && providerClaimPresent;
  const providerSessionId = options.allowProviderAnchor === false ? undefined : strictIdentityText(
    input.providerSessionId
      ?? input.conversationId
      ?? input.threadId
      ?? ((input.sessionIdSource === 'provider' || input.sessionIdSource === 'authenticated_adapter')
        ? input.sessionId : undefined)
      ?? ((defaults.sessionIdSource === 'provider' || defaults.sessionIdSource === 'authenticated_adapter')
        ? defaults.sessionId : undefined)
      ?? attr(
        'providerSessionId', 'provider_session_id', 'conversationId', 'conversation_id',
        'threadId', 'thread_id', 'anysentry.session.id', 'gen_ai.conversation.id',
        'conversation.id', 'session.id',
      ),
    512,
  );
  const sessionId = strictIdentityText(
    untrustedProviderClaim ? undefined : rawSessionId,
    512,
  );
  const runtimeSessionId = strictIdentityText(
    attr('runtimeSessionId', 'runtime_session_id')
      ?? meta.attribution?.agentInstanceId,
    512,
  );
  const logicalAuthority = meta.logicalIdentityAuthority;
  const stableScope = logicalAuthority === 'management_registration'
    || logicalAuthority === 'authenticated_adapter';
  const logicalId = stableScope ? meta.logicalAgentId : undefined;
  const tenantId = stableScope ? meta.tenantId ?? meta.attributes?.tenantId : undefined;
  const ownerId = stableScope ? meta.ownerId ?? meta.attributes?.ownerId : undefined;
  const scopeKey = logicalId && (typeof tenantId === 'string' || typeof ownerId === 'string')
    ? `scope_${createHash('sha256').update([
        logicalId,
        tenantId,
        ownerId,
        meta.environmentId,
        meta.profile,
        meta.profileVersion,
        meta.deploymentId,
        meta.deploymentRevision,
      ].map((value) => value ?? '').join('\0')).digest('hex')}`
    : undefined;
  const serviceStateful = input.serviceStateful ?? defaults.serviceStateful
    ?? (meta.logicalScopeMode === 'workflow_definition' || meta.logicalScopeMode === 'service_definition'
      ? Boolean(providerSessionId)
      : undefined);
  const serviceStatefulHint = serviceStateful !== undefined
    ? serviceStateful
    : false;
  // A stateless service still needs one bounded Session per request/run. Prefer an authenticated
  // invocation/run identity when no provider conversation/thread exists so all spans from one POST
  // share a Session, while different requests (or events without either identity) remain separate.
  const requestIdentity = strictIdentityText(
    (providerSessionId ? explicitSessionId : undefined)
      ?? meta.invocationId
      ?? meta.runId
      ?? meta.sourceEventId,
    512,
  );
  const sourceScopedNamespace = Boolean(
    typeof meta.attributes?.sourceId === 'string'
      && meta.attributes.sourceId.trim()
      && meta.workspacePath,
  );
  const namespaceEligible = (
    Boolean(tenantId || ownerId)
      && Boolean(logicalId || meta.logicalDefinitionId)
      && stableScope
  ) || sourceScopedNamespace;
  const sessionNamespaceHint = namespaceEligible
    ? [...new Set([
        tenantId,
        ownerId,
        logicalId,
        meta.logicalDefinitionId,
        meta.agentId,
        typeof meta.attributes?.sourceId === 'string' ? meta.attributes.sourceId : undefined,
        meta.workspacePath,
      ].filter((value): value is string => Boolean(value)))].join('\0')
    : '';
  const resolution = resolveSessionIdentity({
    providerSessionId,
    sessionId,
    runtimeSessionId,
    serviceStateful: serviceStatefulHint,
    requestId: requestIdentity,
    interactionId: requestIdentity ?? meta.sourceEventId,
    agentInstanceId: meta.attribution?.agentInstanceId,
    resume: input.resume ?? defaults.resume,
    fork: input.fork ?? defaults.fork,
    parentSessionId: strictIdentityText(input.parentSessionId ?? defaults.parentSessionId ?? meta.parentSessionId, 512),
    scopeKey,
    namespaceHint: sessionNamespaceHint,
  });
  const processGenerationKey = meta.process?.processGenerationKey
    ?? deriveProcessGenerationKey({
      hostId: meta.process?.hostId,
      bootId: meta.process?.bootId,
      pid: meta.process?.pid ?? 0,
      startTimeTicks: meta.process?.startTimeTicks,
      startTimeNs: meta.process?.startTimeNs,
    });
  const canonicalInstance = deriveAgentInstanceIdentity({
    logicalAgentId: meta.logicalAgentId,
    logicalDefinitionId: meta.logicalDefinitionId,
    logicalScopeMode: meta.logicalScopeMode,
    deploymentId: meta.deploymentId,
    deploymentRevision: meta.deploymentRevision,
    environmentId: meta.environmentId,
    profile: meta.profile,
    profileVersion: meta.profileVersion,
    processGenerationKey,
  });
  const runtimeInstanceId = meta.runtimeInstanceId
    ?? (meta.process || meta.attribution?.agentInstanceId
      ? agentRuntimeInstanceIdForEvent({
          agentId: meta.agentId,
          workspacePath: meta.workspacePath,
          sessionId: resolution.sessionId,
          attributes: meta.attributes ?? {},
          process: meta.process,
          attribution: meta.attribution,
        })
      : undefined);
  const quality: T.SessionIdentityQuality = stableScope
    ? resolution.quality === 'candidate' || resolution.quality === 'unresolved'
      ? 'unknown'
      : resolution.quality
    : resolution.quality === 'confirmed' ? 'strong'
      : resolution.quality === 'candidate' || resolution.quality === 'unresolved'
        ? 'unknown'
        : resolution.quality;
  const legacySessionId = untrustedProviderClaim
    ? rawSessionId ?? meta.legacySessionId
    : sessionId && sessionId !== resolution.sessionId ? sessionId : meta.legacySessionId;
  const resolvedMeta: T.EventMeta = {
    ...meta,
    sessionId: resolution.sessionId,
    canonicalSessionId: resolution.canonicalSessionId,
    ...(resolution.canonicalSessionKey ? { sessionKey: resolution.canonicalSessionKey } : { sessionKey: undefined }),
    ...(resolution.providerSessionIdHash ? { providerSessionIdHash: resolution.providerSessionIdHash } : { providerSessionIdHash: undefined }),
    sessionIdentityQuality: quality,
    sessionIdSource: untrustedProviderClaim
      ? (rawSessionId ? 'legacy_observer_session' : 'per_request')
      : providerSessionId
        ? 'provider'
      : resolution.source === 'ephemeral' ? 'per_request' : 'unresolved',
    sessionMode: resolution.mode,
    sessionLifecycle: resolution.lifecycle,
    sessionResolutionRevision: boundedCanonicalRevision(meta.sessionResolutionRevision),
    ...(resolution.canonicalParentSessionId
      ? { canonicalParentSessionId: resolution.canonicalParentSessionId }
      : { canonicalParentSessionId: undefined }),
    ...(scopeKey || sessionNamespaceHint
      ? {
          sessionNamespaceKey: scopeKey
            ?? `scope_${createHash('sha256').update(sessionNamespaceHint).digest('hex')}`,
        }
      : {}),
    ...(canonicalInstance.agentInstanceId
      ? { canonicalAgentInstanceId: canonicalInstance.agentInstanceId }
      : {}),
    ...(runtimeInstanceId ? { runtimeInstanceId } : {}),
    ...(resolution.parentSessionId
      ? { parentSessionId: resolution.parentSessionId }
      : { parentSessionId: undefined }),
    ...(legacySessionId ? { legacySessionId } : {}),
  };
  // Session binding is another public clone. Carry the server-only trust capability forward so
  // subsequent Run/semantic authority checks still see the exact Source-policy decision.
  const trustedContext = serverTrustedCorrelationContext(meta);
  if (trustedContext) bindServerTrustedCorrelationContext(resolvedMeta, trustedContext);
  return resolvedMeta;
}

/** Apply the same canonical Session resolver to legacy line/batch ingress when the producer has
 * explicitly marked its Session anchor as provider/adapter-owned (or the event is a service
 * scope).  Raw sessionKey values are never accepted from the wire. */
function bindCanonicalSessionFromMeta(
  meta: T.EventMeta,
  allowProviderAnchor = true,
): T.EventMeta {
  const serviceScope = meta.logicalScopeMode === 'workflow_definition'
    || meta.logicalScopeMode === 'service_definition';
  const providerSessionId = allowProviderAnchor && (meta.sessionIdSource === 'provider'
    || meta.sessionIdSource === 'authenticated_adapter'
    ) ? strictIdentityText(meta.sessionId, 512)
    : undefined;
  const providerClaimMarked = meta.sessionIdSource === 'provider'
    || meta.sessionIdSource === 'authenticated_adapter';
  if (!providerSessionId && !serviceScope && !(providerClaimMarked && !allowProviderAnchor)) return meta;
  return bindUniversalSessionIdentity(
    meta,
    {
      // A service/workflow POST without a provider conversation is intentionally stateless; do
      // not feed deriveMeta's compatibility fallback back into the resolver as an explicit ID.
      ...(providerSessionId || providerClaimMarked ? { sessionId: meta.sessionId } : {}),
      ...(providerClaimMarked ? { sessionIdSource: meta.sessionIdSource } : {}),
      providerSessionId,
      serviceStateful: providerSessionId ? true : false,
      resume: meta.sessionLifecycle === 'resume',
      fork: meta.sessionLifecycle === 'fork',
      parentSessionId: meta.parentSessionId,
      attributes: meta.attributes,
    },
    {
      ...(providerSessionId || providerClaimMarked ? { sessionId: meta.sessionId } : {}),
      ...(providerClaimMarked ? { sessionIdSource: meta.sessionIdSource } : {}),
      serviceStateful: providerSessionId ? true : false,
      attributes: meta.attributes,
    },
    { ignoreMetaSessionFallback: !providerSessionId, allowProviderAnchor: allowProviderAnchor && Boolean(providerSessionId) },
  );
}

type RawProducerCorrelationClaims = {
  invocationId?: unknown;
  toolCallId?: unknown;
  traceId?: unknown;
  sessionId?: unknown;
  runId?: unknown;
  workspacePath?: unknown;
  cwd?: unknown;
  agentId?: unknown;
  collectorId?: unknown;
  attributes?: unknown;
  attribution?: unknown;
};

/** Mirror legacy attribute key selection while retaining each producer value byte-for-byte. */
function rawNormalizedEventAttributes(value: unknown): Record<string, unknown> {
  const input = obj(value);
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input).slice(0, 120)) {
    const normalizedKey = cleanString(key, 80);
    if (!normalizedKey || attrValue(raw, normalizedKey) === undefined) continue;
    out[normalizedKey] = raw;
  }
  return out;
}

function rawAttributeValue(value: unknown, ...keys: string[]): unknown {
  const attributes = rawNormalizedEventAttributes(value);
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(attributes, key)) return attributes[key];
  }
  return undefined;
}

function rawAgentWorkspace(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  return normalized ? `agent://${normalized}` : value;
}

function rawUniversalWorkspace(
  direct: RawProducerCorrelationClaims,
  fallback: RawProducerCorrelationClaims,
): unknown {
  if (direct.workspacePath !== undefined) return direct.workspacePath;
  if (fallback.workspacePath !== undefined) return fallback.workspacePath;
  const cwd = direct.cwd
    ?? obj(direct.attributes)?.cwd;
  if (cwd !== undefined) return cwd;
  return rawAgentWorkspace(direct.agentId ?? fallback.agentId);
}

function rawObserverCorrelationClaims(
  line: string,
  producerClaims: RawProducerCorrelationClaims,
): RawProducerCorrelationClaims {
  if (producerClaims.workspacePath !== undefined) {
    return {
      ...producerClaims,
      attributes: rawNormalizedEventAttributes(producerClaims.attributes),
    };
  }
  let cwd: unknown;
  let agentId: unknown = producerClaims.agentId;
  try {
    const parsed = obj(JSON.parse(line));
    const identity = obj(parsed?.identity);
    const events = obj(parsed?.event);
    const firstEvent = events ? obj(events[Object.keys(events)[0] ?? '']) : undefined;
    cwd = firstEvent?.cwd;
    agentId ??= identity?.agent;
  } catch {
    // Invalid Observer JSON is rejected by the normal ingest path; trust stays unassigned.
  }
  return {
    ...producerClaims,
    workspacePath: cwd ?? rawAgentWorkspace(agentId),
    attributes: rawNormalizedEventAttributes(producerClaims.attributes),
  };
}

// Protocol normalizers must preserve the producer's exact claim values out-of-band. Legacy
// EventMeta normalization intentionally truncates/redacts values for storage and display; using
// those transformed values as authentication claims could merge distinct external identities.
const RAW_UNIVERSAL_CORRELATION_CLAIMS = new WeakMap<object, RawProducerCorrelationClaims>();

function bindRawUniversalCorrelationClaims<T extends object>(
  event: T,
  claims: RawProducerCorrelationClaims,
): T {
  RAW_UNIVERSAL_CORRELATION_CLAIMS.set(event, claims);
  return event;
}

function mergeRawUniversalCorrelationClaimDefaults<T extends object>(
  event: T,
  fallback: Pick<RawProducerCorrelationClaims, 'collectorId' | 'workspacePath'>,
): T {
  const claims = RAW_UNIVERSAL_CORRELATION_CLAIMS.get(event);
  if (!claims) return event;
  RAW_UNIVERSAL_CORRELATION_CLAIMS.set(event, {
    ...claims,
    collectorId: claims.collectorId !== undefined ? claims.collectorId : fallback.collectorId,
    workspacePath: claims.workspacePath !== undefined ? claims.workspacePath : fallback.workspacePath,
  });
  return event;
}

function rawMetaAttribute(meta: RawProducerCorrelationClaims, ...keys: string[]): unknown {
  const attributes = obj(meta.attributes);
  if (!attributes) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(attributes, key)) return attributes[key];
  }
  return undefined;
}

function rawUniversalCorrelationClaims(
  input: T.UniversalIngestEvent,
  defaults: T.UniversalIngestRequest,
): RawProducerCorrelationClaims {
  const preserved = RAW_UNIVERSAL_CORRELATION_CLAIMS.get(input);
  if (preserved) return preserved;
  const direct = input as RawProducerCorrelationClaims;
  const fallback = defaults as RawProducerCorrelationClaims;
  return {
    invocationId: direct.invocationId !== undefined ? direct.invocationId : fallback.invocationId,
    toolCallId: direct.toolCallId !== undefined ? direct.toolCallId : fallback.toolCallId,
    traceId: direct.traceId !== undefined ? direct.traceId : fallback.traceId,
    sessionId: direct.sessionId !== undefined ? direct.sessionId : fallback.sessionId,
    runId: direct.runId !== undefined ? direct.runId : fallback.runId,
    workspacePath: rawUniversalWorkspace(direct, fallback),
    collectorId: direct.collectorId
      ?? obj(direct.attributes)?.collectorId
      ?? fallback.collectorId,
    attributes: {
      ...rawNormalizedEventAttributes(fallback.attributes),
      ...rawNormalizedEventAttributes(direct.attributes),
    },
    attribution: direct.attribution !== undefined ? direct.attribution : fallback.attribution,
  };
}

/** Build a preliminary, bounded Source-policy claim for the batch envelope. The exact per-event
 * check still runs in `bindTrustedCorrelationForIngest`; this early hint only lets a homogeneous
 * universal request retain its server capability instead of being downgraded by a missing batch
 * claim. No producer value is trusted until `authorizeCorrelationClaims` validates it. */
function universalCorrelationClaimForResolve(
  input: T.UniversalIngestEvent | undefined,
  defaults: T.UniversalIngestRequest,
): import('./ingestion-source.service').IngestionSourceCorrelationClaimRequest | undefined {
  if (!input) return undefined;
  const attrs = {
    ...(defaults.attributes ?? {}),
    ...(input.attributes ?? {}),
  };
  const value = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (attrs[key] !== undefined) return attrs[key];
    }
    return undefined;
  };
  const kind = canonicalEventKind(input);
  const explicitAdapterClaim = kind === 'AgentTool' || kind === 'AgentInvocation'
    || input.toolCallId !== undefined
    || value(
      'anysentry.adapter.schema',
      'anysentry.adapter.runtime',
      'tool_call.id',
      'gen_ai.tool.call.id',
    ) !== undefined;
  const authority = explicitAdapterClaim
    ? 'agent_adapter' as const
    : 'application' as const;
  const claim = {
    authority,
    tenantId: input.tenantId ?? defaults.tenantId ?? value('tenantId', 'tenant.id', 'anysentry.tenant.id'),
    environmentId: input.environmentId ?? defaults.environmentId ?? value('environmentId', 'environment.id', 'deployment.environment.name'),
    workspaceId: value('workspaceId', 'workspace.id', 'anysentry.workspace.id'),
    workspacePath: input.workspacePath ?? defaults.workspacePath,
    collectorId: input.collectorId ?? defaults.collectorId,
    physicalWorkloadId: input.attribution?.physicalWorkloadId ?? defaults.attribution?.physicalWorkloadId
      ?? value('physicalWorkloadId', 'physical_workload_id'),
    agentScopeId: input.attribution?.agentScopeId ?? defaults.attribution?.agentScopeId
      ?? value('agentScopeId', 'agent_scope_id'),
  } satisfies import('./ingestion-source.service').IngestionSourceCorrelationClaimRequest;
  return claim;
}

function metaAttributeText(meta: Partial<T.EventMeta>, ...keys: string[]): string | undefined {
  const attributes = meta.attributes ?? {};
  for (const key of keys) {
    const value = attributes[key];
    const text = cleanString(value, 512);
    if (text) return text;
  }
  return undefined;
}

function trustedEventScope(meta: T.EventMeta): TrustedCorrelationBindingScope {
  return {
    tenantId: meta.tenantId
      ?? metaAttributeText(meta, 'tenantId', 'tenant.id', 'anysentry.tenant.id')
      ?? process.env.ANYSENTRY_TENANT_ID?.trim()
      ?? 'default',
    environmentId: meta.environmentId
      ?? metaAttributeText(
      meta,
      'environmentId',
      'environment.id',
      'anysentry.environment.id',
      'deployment.environment.name',
    ) ?? process.env.ANYSENTRY_ENVIRONMENT_ID?.trim() ?? 'local',
    workspaceId: metaAttributeText(meta, 'workspaceId', 'workspace.id', 'anysentry.workspace.id'),
    workspacePath: cleanString(meta.workspacePath, 500),
    physicalWorkloadId: cleanString(meta.attribution?.physicalWorkloadId, 240),
    agentScopeId: cleanString(meta.attribution?.agentScopeId, 160)
      ?? metaAttributeText(meta, 'agentScopeId', 'agent_scope_id'),
  };
}

function trustedClaimRejectionReason(
  reason: T.CorrelationClaimAuthorizationReason,
): TrustedCorrelationClaimRejectionReason | undefined {
  if (reason === 'authorized') return undefined;
  if (reason === 'authority_mismatch' || reason === 'source_type_not_allowed') return 'authority_mismatch';
  if (
    reason === 'policy_invalid' ||
    reason === 'claim_scope_missing' ||
    reason === 'required_scope_missing' ||
    reason.endsWith('_binding_missing')
  ) return 'binding_incomplete';
  if (reason.endsWith('_binding_mismatch')) return 'binding_mismatch';
  if (reason === 'policy_disabled') return 'claim_not_allowed';
  if (
    reason === 'token_missing' ||
    reason === 'token_invalid' ||
    reason === 'protected_source_required'
  ) return 'source_unauthenticated';
  return 'source_unverified';
}

/**
 * Bind server-only trust material to the final EventMeta object. Event acceptance remains a
 * separate decision: an unauthorized claim is measured and ignored, never promoted to identity.
 */
function bindTrustedCorrelationForIngest(
  meta: T.EventMeta,
  producerClaims: RawProducerCorrelationClaims,
  resolution: IngestionSourceResolution,
  tokenProvided: boolean,
  serverClassificationObserved = false,
  serverInventoryObserved = false,
): T.EventMeta {
  const trustedClassificationProducer = isTrustedCollectorProducer(
    resolution,
    metaAttributeText(meta, 'collectorId'),
  );
  // The S3 view is a resolved Collector result, not a producer claim. Generic, discovered and
  // tokenless sources may still use the legacy ingest contract, but cannot publish roles,
  // capture profiles or Unknown-reason facts into the trusted read model.
  const boundMeta = trustedClassificationProducer || serverClassificationObserved
    ? { ...meta, process: visibleProcessContext(meta.process) }
    : {
        ...meta,
        classificationSemantics: undefined,
        process: processContextWithoutLifecycle(meta.process),
      };

  if (correlationCaptureRollout().trustedCorrelation === 'off') return boundMeta;
  const scope = trustedEventScope(boundMeta);
  const policy = resolution.source?.correlationClaims;
  const configuredAuthority = policy?.authority;
  const rawAttribution = obj(producerClaims.attribution);
  const invocationId = producerClaims.invocationId
    ?? rawMetaAttribute(
      producerClaims,
      'anysentry.invocation.id',
      'gen_ai.invocation.id',
      'gen_ai.request.id',
    );
  const toolCallId = producerClaims.toolCallId
    ?? rawMetaAttribute(
      producerClaims,
      'anysentry.tool_call.id',
      'anysentry.tool.call.id',
      'gen_ai.tool.call.id',
      'tool_call.id',
    );
  const traceId = producerClaims.traceId;
  const sessionId = producerClaims.sessionId;
  const runId = producerClaims.runId
    ?? rawMetaAttribute(
      producerClaims,
      'runId',
      'anysentry.run.id',
      'anysentry.run_id',
      'run.id',
      'gen_ai.run.id',
      'workflow_run_id',
      'langgraph.run_id',
    );
  const claimSupplied = (value: unknown): boolean => value !== undefined && value !== null;
  const traceConsistent = claimSupplied(traceId)
    ? strictIdentityText(traceId, 512) === boundMeta.traceId
    : undefined;
  const sessionConsistent = claimSupplied(sessionId)
    ? strictIdentityText(sessionId, 512) === boundMeta.sessionId
    : undefined;
  const semanticAuthority = configuredAuthority === 'application' || configuredAuthority === 'agent_adapter'
    ? configuredAuthority
    : claimSupplied(toolCallId)
      ? 'agent_adapter'
      : 'application';
  const hasSemanticClaim = semanticAuthority === 'agent_adapter'
    ? [invocationId, toolCallId, sessionId, traceId, runId].some(claimSupplied)
    : [invocationId, traceId, runId].some(claimSupplied);
  const policyBindings = policy?.bindings;
  const finalCollectorId = metaAttributeText(boundMeta, 'collectorId');
  const rawTenantId = rawMetaAttribute(producerClaims, 'tenantId', 'tenant.id', 'anysentry.tenant.id');
  const rawEnvironmentId = rawMetaAttribute(
    producerClaims,
    'environmentId',
    'environment.id',
    'anysentry.environment.id',
    'deployment.environment.name',
  );
  const rawWorkspaceId = rawMetaAttribute(producerClaims, 'workspaceId', 'workspace.id', 'anysentry.workspace.id');
  const rawCollectorId = producerClaims.collectorId
    ?? rawMetaAttribute(producerClaims, 'collectorId');
  const rawPhysicalWorkloadId = rawAttribution?.physicalWorkloadId
    ?? rawMetaAttribute(producerClaims, 'physicalWorkloadId');
  const rawAgentScopeId = rawAttribution?.agentScopeId
    ?? rawMetaAttribute(producerClaims, 'agentScopeId');
  const rawScopeConflict = (
    raw: unknown,
    canonical: string | undefined,
    limit: number,
    configured: boolean,
    reason: T.CorrelationClaimAuthorizationReason,
  ): T.CorrelationClaimAuthorizationReason | undefined => {
    if (!configured || raw === undefined) return undefined;
    const parsed = strictIdentityText(raw, limit);
    return parsed && parsed === canonical ? undefined : reason;
  };
  const scopeIntegrityFailure = [
    rawScopeConflict(rawTenantId, scope.tenantId, 160, Boolean(policyBindings?.tenantIds.length), 'tenant_binding_mismatch'),
    rawScopeConflict(rawEnvironmentId, scope.environmentId, 80, Boolean(policyBindings?.environmentIds.length), 'environment_binding_mismatch'),
    rawScopeConflict(rawWorkspaceId, scope.workspaceId, 180, Boolean(policyBindings?.workspaceIds.length), 'workspace_binding_mismatch'),
    rawScopeConflict(producerClaims.workspacePath, scope.workspacePath, 500, Boolean(policyBindings?.workspacePaths.length), 'workspace_binding_mismatch'),
    rawScopeConflict(rawCollectorId, finalCollectorId, 180, Boolean(policyBindings?.collectorIds.length), 'collector_binding_mismatch'),
    rawScopeConflict(rawPhysicalWorkloadId, scope.physicalWorkloadId, 240, Boolean(policyBindings?.physicalWorkloadIds.length), 'workload_binding_mismatch'),
    rawScopeConflict(rawAgentScopeId, scope.agentScopeId, 160, Boolean(policyBindings?.agentScopeIds.length), 'agent_binding_mismatch'),
  ].find((reason): reason is T.CorrelationClaimAuthorizationReason => Boolean(reason));
  const claimRequest = {
    authority: configuredAuthority,
    ...(configuredAuthority !== 'observer_runtime' || policyBindings?.tenantIds.length
      ? { tenantId: scope.tenantId }
      : {}),
    ...(configuredAuthority !== 'observer_runtime' || policyBindings?.environmentIds.length
      ? { environmentId: scope.environmentId }
      : {}),
    ...(policyBindings?.workspaceIds.length ? { workspaceId: scope.workspaceId } : {}),
    ...(policyBindings?.workspacePaths.length ? { workspacePath: scope.workspacePath } : {}),
    ...(configuredAuthority === 'observer_runtime' || policyBindings?.collectorIds.length
      ? { collectorId: finalCollectorId }
      : {}),
    ...(policyBindings?.physicalWorkloadIds.length ? { physicalWorkloadId: scope.physicalWorkloadId } : {}),
    ...(policyBindings?.agentScopeIds.length ? { agentScopeId: scope.agentScopeId } : {}),
  } satisfies import('./ingestion-source.service').IngestionSourceCorrelationClaimRequest;
  const authorize = (authority: T.CorrelationClaimAuthority | undefined) => {
    const result = authorizeCorrelationClaims({
      source: resolution.source,
      tokenProvided,
      tokenMatched: resolution.authenticated,
      claim: { ...claimRequest, authority },
    });
    return result.claimAuthorization && scopeIntegrityFailure
      ? {
          ...result,
          claimAuthorization: false as const,
          claimAuthorizationReason: scopeIntegrityFailure,
        }
      : result;
  };
  const authorization = authorize(configuredAuthority);
  const observerAttested = configuredAuthority === 'observer_runtime' && authorization.claimAuthorization;

  let sourceTrust: ServerSourceTrustContext | undefined;
  let claims: TrustedCorrelationInput['claims'];
  if (hasSemanticClaim) {
    const kind = semanticAuthority === 'agent_adapter' ? 'agent_adapter' : 'application_trace';
    const semanticAuthorization = configuredAuthority === semanticAuthority
      ? authorization
      : authorize(semanticAuthority);
    sourceTrust = {
      verification: 'server_verified',
      authenticated: resolution.authenticated,
      authority: semanticAuthority,
      allowedClaims: semanticAuthorization.claimAuthorization ? [kind] : [],
      bindings: scope,
      rejectionReason: trustedClaimRejectionReason(semanticAuthorization.claimAuthorizationReason),
    };
    claims = semanticAuthority === 'agent_adapter'
      ? {
              agentAdapter: {
                invocationId,
                toolCallId,
                sessionId,
                traceId,
                runId,
                sessionConsistent,
                traceConsistent,
                scope,
          },
        }
      : {
          application: {
            invocationId,
            traceId,
            runId,
            traceConsistent,
            scope,
          },
      };
  }
  // A scope mismatch is security-relevant even when the event did not carry a semantic claim.
  // Materialize a rejected server context so the identity quarantine below cannot be bypassed by
  // a metadata-only event that happened to inherit a management registration.
  if (!sourceTrust && scopeIntegrityFailure) {
    sourceTrust = {
      verification: 'server_verified',
      authenticated: resolution.authenticated,
      authority: semanticAuthority,
      allowedClaims: [],
      bindings: scope,
      rejectionReason: trustedClaimRejectionReason(scopeIntegrityFailure),
    };
  }
  const trustedMeta = bindServerTrustedCorrelationContext(boundMeta, {
    sourceTrust,
    claims,
    observerAttested,
    serverInventoryObserved: authorization.claimAuthorization &&
      configuredAuthority !== 'observer_runtime' &&
      !producerClaims.attribution && (
        serverInventoryObserved || (
          Boolean(
            scope.physicalWorkloadId &&
            policyBindings?.physicalWorkloadIds.includes(scope.physicalWorkloadId),
          ) && (
            boundMeta.attribution?.source === 'kubernetes' ||
            boundMeta.attribution?.source === 'docker' ||
            boundMeta.attribution?.source === 'systemd' ||
            boundMeta.attribution?.source === 'manual_review'
          )
        )
      ),
  });
  return quarantineRejectedScope(trustedMeta);
}

/**
 * Never let a producer claim that failed the Source binding fence inherit a management logical
 * definition.  The raw/process/kernel lane remains intact; only the functional identity and
 * namespaced Session material are cleared and retained as an unresolved candidate.
 */
function quarantineRejectedScope(meta: T.EventMeta): T.EventMeta {
  const context = serverTrustedCorrelationContext(meta);
  if (!context?.sourceTrust?.rejectionReason) return meta;
  const candidate = meta.logicalAgentCandidateId
    ?? (meta.logicalAgentId
      ? `lac_${createHash('sha256').update(`scope-mismatch\0${meta.logicalAgentId}`).digest('hex').slice(0, 24)}`
      : undefined);
  const quarantined: T.EventMeta = {
    ...meta,
    logicalAgentId: undefined,
    logicalDefinitionId: undefined,
    logicalDefinitionFingerprint: undefined,
    logicalScopeMode: 'unresolved',
    logicalIdentityAuthority: 'unknown',
    ...(candidate ? { logicalAgentCandidateId: candidate } : {}),
    canonicalAgentInstanceId: undefined,
    sessionKey: undefined,
    sessionNamespaceKey: undefined,
    providerSessionIdHash: undefined,
  };
  bindServerTrustedCorrelationContext(quarantined, context);
  return quarantined;
}

const SECURITY_CAPABILITY_ACTIONS: T.SecurityCapabilityAction[] = ['list', 'search', 'describe', 'execute'];
const SECURITY_CAPABILITY_STAGES: T.SecurityCapabilityStage[] = ['input', 'plan', 'tool', 'retrieval', 'memory', 'llm', 'output', 'feedback', 'runtime'];
const SECURITY_CAPABILITY_AUTONOMY: T.SecurityCapabilityAutonomy[] = ['suggest', 'guarded', 'auto'];

const SECURITY_PROGRESSIVE_MODULE = 'security-center';

const SECURITY_PROGRESSIVE_ALIASES: Record<string, { module: string; operation: string }> = {
  'security.runtimeGuard': { module: SECURITY_PROGRESSIVE_MODULE, operation: 'assessRuntimeAction' },
  'security.eventIngest': { module: SECURITY_PROGRESSIVE_MODULE, operation: 'recordSecurityEvents' },
  'security.evidenceBundle': { module: SECURITY_PROGRESSIVE_MODULE, operation: 'buildEvidenceBundle' },
  'security.nextActions': { module: SECURITY_PROGRESSIVE_MODULE, operation: 'planNextActions' },
};

const SECURITY_TIME_TYPES = ['last_3h', 'last_1d', 'last_7d', 'last_30d', 'custom'];
const SECURITY_SEVERITIES: T.Severity[] = ['info', 'low', 'medium', 'high', 'critical'];
const SECURITY_EVENT_CATEGORIES: T.EventCategory[] = ['tool', 'network', 'file', 'llm', 'security', 'process', 'runtime', 'unknown'];
const SECURITY_VERDICTS: T.Verdict[] = ['allow', 'block', 'escalate'];
const SECURITY_INGESTION_SOURCE_TYPES: T.IngestionSourceType[] = ['observer', 'forwarder', 'webhook', 'otel', 'custom'];
const SECURITY_REMEDIATION_STATUSES: Array<T.RemediationStatus | 'all'> = ['open', 'in_progress', 'blocked', 'done', 'dismissed', 'all'];
const SECURITY_REMEDIATION_SOURCE_TYPES: Array<T.RemediationSourceType | 'all'> = ['incident', 'alert', 'coverage', 'all'];
const SECURITY_REMEDIATION_ACTION_KINDS: Array<T.RemediationActionKind | 'all'> = [
  'investigate',
  'collector',
  'source',
  'policy',
  'credential',
  'network',
  'file',
  'ownership',
  'all',
];

const EVENT_ATTRIBUTE_VALUE_SCHEMA = { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] };
const STRING_OR_STRING_ARRAY_SCHEMA = { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] };
const TIMESTAMP_SCHEMA = { oneOf: [{ type: 'string', format: 'date-time' }, { type: 'number', description: 'Epoch milliseconds.' }] };

const SECURITY_TIME_FILTER_SCHEMA_PROPERTIES = {
  timeType: { type: 'string', enum: SECURITY_TIME_TYPES, default: 'last_3h' },
  startTime: { type: 'string', format: 'date-time', description: 'Required when timeType=custom.' },
  endTime: { type: 'string', format: 'date-time', description: 'Required when timeType=custom.' },
};

function progressiveExecuteInputSchema(operation: string, paramsSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    body: {
      type: 'object',
      required: ['action', 'module', 'operation', 'params'],
      additionalProperties: false,
      properties: {
        action: { const: 'execute' },
        module: { const: SECURITY_PROGRESSIVE_MODULE },
        operation: { const: operation },
        params: paramsSchema,
        dryRun: { type: 'boolean', description: 'Validate dispatch, scope, and token context without executing side effects.' },
        shaped: { type: 'boolean', description: 'Wrap the raw result in the source-compatible progressive response envelope.' },
        sessionId: { type: 'string', description: 'Optional caller session id used for client-side correlation.' },
        constraints: {
          type: 'object',
          additionalProperties: false,
          properties: {
            noNetworkActivity: { type: 'boolean' },
            noDestructiveActions: { type: 'boolean' },
            maxRiskLevel: { type: 'string', enum: SECURITY_SEVERITIES },
            autonomy: { type: 'string', enum: SECURITY_CAPABILITY_AUTONOMY },
          },
        },
      },
    },
    contentType: 'application/json',
  };
}

const SECURITY_RUNTIME_GUARD_PARAMS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  properties: {
    autonomy: { type: 'string', enum: SECURITY_CAPABILITY_AUTONOMY, default: 'guarded', description: 'suggest warns only, guarded gates risky actions, auto blocks high-risk actions.' },
    stage: { type: 'string', enum: SECURITY_CAPABILITY_STAGES, default: 'runtime', description: 'Lifecycle stage of the AI action being assessed.' },
    workspacePath: { type: 'string' },
    agentId: { type: 'string' },
    sessionId: { type: 'string' },
    userId: { type: 'string' },
    traceId: { type: 'string' },
    spanId: { type: 'string' },
    parentSpanId: { type: 'string' },
    runId: { type: 'string' },
    taskId: { type: 'string' },
    collectorId: { type: 'string' },
    sourceId: { type: 'string' },
    sourceName: { type: 'string' },
    token: { type: 'string', description: 'Ingest/source token, when not supplied through headers.' },
    action: { type: 'string', description: 'Human-readable action summary.' },
    toolName: { type: 'string' },
    toolArgs: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'string' }] },
    command: STRING_OR_STRING_ARRAY_SCHEMA,
    target: { type: 'string' },
    resource: { type: 'string' },
    input: { type: 'string' },
    prompt: { type: 'string' },
    output: { type: 'string' },
    model: { type: 'string' },
    subject: { type: 'string' },
    labels: { type: 'object', additionalProperties: EVENT_ATTRIBUTE_VALUE_SCHEMA },
    evidence: { type: 'object', additionalProperties: true },
    tokenCount: { type: 'number' },
    latencyMs: { type: 'number' },
  },
};

const SECURITY_RECORD_EVENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  properties: {
    at: TIMESTAMP_SCHEMA,
    timestamp: TIMESTAMP_SCHEMA,
    workspacePath: { type: 'string' },
    agentId: { type: 'string' },
    sessionId: { type: 'string' },
    userId: { type: 'string' },
    traceId: { type: 'string' },
    spanId: { type: 'string' },
    parentSpanId: { type: 'string' },
    runId: { type: 'string' },
    taskId: { type: 'string' },
    eventKind: { type: 'string' },
    kind: { type: 'string' },
    eventCategory: { type: 'string', enum: SECURITY_EVENT_CATEGORIES },
    category: { type: 'string', enum: SECURITY_EVENT_CATEGORIES },
    subject: { type: 'string' },
    command: STRING_OR_STRING_ARRAY_SCHEMA,
    argv: STRING_OR_STRING_ARRAY_SCHEMA,
    peer: { type: 'string' },
    port: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    path: { type: 'string' },
    sni: { type: 'string' },
    endpoint: { type: 'string' },
    content: { type: 'string' },
    data: { type: 'string' },
    runtimeKind: { type: 'string' },
    verdict: { type: 'string', enum: SECURITY_VERDICTS },
    severity: { type: 'string', enum: SECURITY_SEVERITIES },
    attributes: { type: 'object', additionalProperties: EVENT_ATTRIBUTE_VALUE_SCHEMA },
    raw: {},
  },
};

const SECURITY_RECORD_EVENTS_PARAMS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  anyOf: [{ required: ['events'] }, { required: ['event'] }, { required: ['type', 'data'] }],
  properties: {
    workspacePath: { type: 'string' },
    agentId: { type: 'string' },
    sessionId: { type: 'string' },
    userId: { type: 'string' },
    traceId: { type: 'string' },
    spanId: { type: 'string' },
    parentSpanId: { type: 'string' },
    runId: { type: 'string' },
    taskId: { type: 'string' },
    collectorId: { type: 'string' },
    sourceId: { type: 'string' },
    sourceName: { type: 'string' },
    sourceType: { type: 'string', enum: SECURITY_INGESTION_SOURCE_TYPES, default: 'custom' },
    token: { type: 'string' },
    event: SECURITY_RECORD_EVENT_SCHEMA,
    events: { type: 'array', minItems: 1, items: SECURITY_RECORD_EVENT_SCHEMA },
    specversion: { type: 'string' },
    specVersion: { type: 'string' },
    id: { type: 'string' },
    type: { type: 'string', description: 'CloudEvents type.' },
    datacontenttype: { type: 'string' },
    dataschema: { type: 'string' },
    time: { type: 'string', format: 'date-time' },
    data_base64: { type: 'string' },
    data: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'string' }] },
  },
};

const SECURITY_EVIDENCE_BUNDLE_PARAMS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SECURITY_TIME_FILTER_SCHEMA_PROPERTIES,
    auditId: { type: 'string' },
    edgeId: { type: 'string' },
    eventId: { type: 'string' },
    incidentId: { type: 'string' },
    alertId: { type: 'string' },
    taskId: { type: 'string' },
    objectiveId: { type: 'string' },
    issueId: { type: 'string' },
    deliveryId: { type: 'string' },
    windowId: { type: 'string' },
    workspacePath: { type: 'string' },
    agentId: { type: 'string' },
    collectorId: { type: 'string' },
    sourceId: { type: 'string' },
    traceId: { type: 'string' },
    runId: { type: 'string' },
    sessionId: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 40 },
  },
};

const SECURITY_NEXT_ACTION_PLAN_PARAMS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SECURITY_TIME_FILTER_SCHEMA_PROPERTIES,
    taskId: { type: 'string' },
    incidentId: { type: 'string' },
    alertId: { type: 'string' },
    eventId: { type: 'string' },
    objectiveId: { type: 'string' },
    issueId: { type: 'string' },
    status: { type: 'string', enum: SECURITY_REMEDIATION_STATUSES, default: 'all' },
    severity: { type: 'string', enum: [...SECURITY_SEVERITIES, 'all'] },
    sourceType: { type: 'string', enum: SECURITY_REMEDIATION_SOURCE_TYPES },
    actionKind: { type: 'string', enum: SECURITY_REMEDIATION_ACTION_KINDS },
    q: { type: 'string' },
    workspacePath: { type: 'string' },
    agentId: { type: 'string' },
    collectorId: { type: 'string' },
    sourceId: { type: 'string' },
    owner: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    maxActions: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
    includeCompletedSteps: { type: 'boolean', default: false },
  },
};

const SECURITY_RUNTIME_GUARD_OUTPUT_SCHEMA = {
  schemaVersion: 'anysentry.progressive.runtime_guard.result.v1',
  type: 'object',
  required: ['schemaVersion', 'module', 'operation', 'autonomy', 'stage', 'policyAction', 'recommendedAction', 'accepted'],
  properties: {
    schemaVersion: { const: 'anysentry.progressive.runtime_guard.result.v1' },
    module: { const: SECURITY_PROGRESSIVE_MODULE },
    operation: { const: 'assessRuntimeAction' },
    capabilityId: { const: 'security.runtimeGuard' },
    autonomy: { type: 'string', enum: SECURITY_CAPABILITY_AUTONOMY },
    stage: { type: 'string', enum: SECURITY_CAPABILITY_STAGES },
    policyAction: { type: 'string', enum: ['allow', 'warn', 'require_approval', 'block'] },
    recommendedAction: { type: 'string', enum: ['continue', 'review', 'stop'] },
    accepted: { type: 'boolean' },
    sourceId: { type: 'string' },
    eventId: { type: 'string' },
    traceId: { type: 'string' },
    runId: { type: 'string' },
    verdict: { type: 'string', enum: SECURITY_VERDICTS },
    tier: { type: 'string', enum: ['Rules', 'Llm', 'Agent'] },
    severity: { type: 'string', enum: SECURITY_SEVERITIES },
    riskCategory: { type: 'string' },
    reason: { type: 'string' },
    evidence: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        eventsHref: { type: 'string' },
        bundleHint: SECURITY_EVIDENCE_BUNDLE_PARAMS_SCHEMA,
      },
    },
  },
};

const SECURITY_UNIVERSAL_INGEST_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['accepted', 'acceptedEvents', 'rejectedEvents', 'items'],
  properties: {
    accepted: { type: 'boolean' },
    sourceId: { type: 'string' },
    acceptedEvents: { type: 'number' },
    rejectedEvents: { type: 'number' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'accepted'],
        properties: {
          index: { type: 'number' },
          accepted: { type: 'boolean' },
          reason: { type: 'string' },
          eventId: { type: 'string' },
          traceId: { type: 'string' },
          spanId: { type: 'string' },
          runId: { type: 'string' },
          verdict: { type: 'string', enum: SECURITY_VERDICTS },
          tier: { type: 'string', enum: ['Rules', 'Llm', 'Agent'] },
          severity: { type: 'string', enum: SECURITY_SEVERITIES },
          riskCategory: { type: 'string' },
        },
      },
    },
  },
};

const SECURITY_EVIDENCE_BUNDLE_OUTPUT_SCHEMA = {
  schemaVersion: 'anysentry.evidence_bundle.v1',
  type: 'object',
  required: ['schemaVersion', 'bundleId', 'generatedAt', 'scope', 'summary', 'events', 'remediations'],
  properties: {
    schemaVersion: { const: 'anysentry.evidence_bundle.v1' },
    bundleId: { type: 'string' },
    generatedAt: { type: 'string', format: 'date-time' },
    scope: { type: 'object' },
    summary: {
      type: 'object',
      required: ['eventCount', 'incidentCount', 'alertCount', 'remediationCount'],
      properties: {
        eventCount: { type: 'number' },
        incidentCount: { type: 'number' },
        alertCount: { type: 'number' },
        remediationCount: { type: 'number' },
        maxSeverity: { type: 'string', enum: SECURITY_SEVERITIES },
        riskCategories: { type: 'array', items: { type: 'object' } },
      },
    },
    primary: { type: 'object' },
    timeline: { type: 'object' },
    events: { type: 'array', items: { type: 'object' } },
    incidents: { type: 'array', items: { type: 'object' } },
    alerts: { type: 'array', items: { type: 'object' } },
    remediations: { type: 'array', items: { type: 'object' } },
    objectives: { type: 'array', items: { type: 'object' } },
    notificationDeliveries: { type: 'array', items: { type: 'object' } },
    maintenanceWindows: { type: 'array', items: { type: 'object' } },
    coverageIssues: { type: 'array', items: { type: 'object' } },
    topology: { type: 'object' },
    agents: { type: 'array', items: { type: 'object' } },
    workspaces: { type: 'array', items: { type: 'object' } },
    sources: { type: 'array', items: { type: 'object' } },
    collectors: { type: 'array', items: { type: 'object' } },
    audits: { type: 'array', items: { type: 'object' } },
  },
};

const SECURITY_NEXT_ACTION_PLAN_OUTPUT_SCHEMA = {
  schemaVersion: 'anysentry.progressive.next_action_plan.v1',
  type: 'object',
  required: ['schemaVersion', 'module', 'operation', 'generatedAt', 'scope', 'summary', 'actions'],
  properties: {
    schemaVersion: { const: 'anysentry.progressive.next_action_plan.v1' },
    module: { const: SECURITY_PROGRESSIVE_MODULE },
    operation: { const: 'planNextActions' },
    generatedAt: { type: 'string', format: 'date-time' },
    scope: { type: 'object' },
    summary: {
      type: 'object',
      required: ['totalCandidates', 'returnedActions', 'criticalActions', 'overdueActions', 'approvalRequiredActions'],
      properties: {
        totalCandidates: { type: 'number' },
        returnedActions: { type: 'number' },
        criticalActions: { type: 'number' },
        overdueActions: { type: 'number' },
        approvalRequiredActions: { type: 'number' },
      },
    },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['actionId', 'taskId', 'rank', 'priority', 'status', 'severity', 'title', 'recommendedAction', 'evidence', 'nextSteps'],
        properties: {
          actionId: { type: 'string' },
          taskId: { type: 'string' },
          rank: { type: 'number' },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          status: { type: 'string', enum: SECURITY_REMEDIATION_STATUSES.filter((status) => status !== 'all') },
          severity: { type: 'string', enum: SECURITY_SEVERITIES },
          title: { type: 'string' },
          recommendedAction: { type: 'string' },
          actionKind: { type: 'string', enum: SECURITY_REMEDIATION_ACTION_KINDS.filter((kind) => kind !== 'all') },
          sourceType: { type: 'string', enum: SECURITY_REMEDIATION_SOURCE_TYPES.filter((type) => type !== 'all') },
          sourceId: { type: 'string' },
          owner: { type: 'string' },
          dueAt: { type: 'string', format: 'date-time' },
          overdue: { type: 'boolean' },
          needsApproval: { type: 'boolean' },
          evidence: {
            type: 'object',
            required: ['primaryType', 'primaryId', 'taskId', 'bundleHint'],
            properties: {
              primaryType: { type: 'string' },
              primaryId: { type: 'string' },
              eventId: { type: 'string' },
              incidentId: { type: 'string' },
              alertId: { type: 'string' },
              taskId: { type: 'string' },
              objectiveId: { type: 'string' },
              issueId: { type: 'string' },
              bundleHint: SECURITY_EVIDENCE_BUNDLE_PARAMS_SCHEMA,
            },
          },
          nextSteps: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  },
};

const SECURITY_PROGRESSIVE_MODULES: T.SecurityApiModule[] = [
  {
    name: SECURITY_PROGRESSIVE_MODULE,
    description: 'AnySentry security-center progressive API module, using the source-compatible capabilities pattern.',
    path: '/security-center',
    operations: [
      {
        name: 'assessRuntimeAction',
        operationId: 'assessRuntimeAction',
        description: 'Assess one AI runtime action/tool/model/output event and return an allow/warn/require_approval/block decision.',
        method: 'POST',
        path: '/security-center/capabilities',
        resource: 'security-center.runtime-guard',
        action: 'execute',
        tags: ['security-center', 'runtime-guard', 'progressive-api'],
        parameters: [
          { name: 'autonomy', in: 'body', type: 'string', required: false, description: 'suggest | guarded | auto', enum: SECURITY_CAPABILITY_AUTONOMY },
          { name: 'stage', in: 'body', type: 'string', required: false, description: 'input/plan/tool/retrieval/memory/llm/output/feedback/runtime' },
          { name: 'workspacePath', in: 'body', type: 'string', required: false, description: 'Workspace, repository, or logical scope for the action.' },
          { name: 'agentId', in: 'body', type: 'string', required: false, description: 'Agent identity.' },
          { name: 'sessionId', in: 'body', type: 'string', required: false, description: 'Agent session id.' },
          { name: 'toolName', in: 'body', type: 'string', required: false, description: 'Tool name for tool-stage events.' },
          { name: 'command', in: 'body', type: 'object', required: false, description: 'Command string or argv list.' },
        ],
        inputSchema: progressiveExecuteInputSchema('assessRuntimeAction', SECURITY_RUNTIME_GUARD_PARAMS_SCHEMA),
        outputSchema: {
          status: 200,
          envelope: 'standard',
          contentTypes: ['application/json'],
          data: SECURITY_RUNTIME_GUARD_OUTPUT_SCHEMA,
        },
        examples: [
          {
            description: 'Guard a shell tool call',
            request: {
              action: 'execute',
              module: SECURITY_PROGRESSIVE_MODULE,
              operation: 'assessRuntimeAction',
              params: { autonomy: 'guarded', stage: 'tool', toolName: 'bash', command: ['bash', '-lc', 'id'] },
            },
          },
        ],
      },
      {
        name: 'recordSecurityEvents',
        operationId: 'recordSecurityEvents',
        description: 'Normalize custom, webhook, CloudEvents, or OpenTelemetry-shaped evidence into AnySentry security-center events.',
        method: 'POST',
        path: '/security-center/capabilities',
        resource: 'security-center.ingest',
        action: 'create',
        tags: ['security-center', 'ingest', 'progressive-api'],
        parameters: [
          { name: 'events', in: 'body', type: 'object', required: true, description: 'Universal ingest request events array.' },
          { name: 'sourceName', in: 'body', type: 'string', required: false, description: 'Logical producer/source name.' },
          { name: 'sourceType', in: 'body', type: 'string', required: false, description: 'custom/webhook/sdk/otel/observer.' },
        ],
        inputSchema: progressiveExecuteInputSchema('recordSecurityEvents', SECURITY_RECORD_EVENTS_PARAMS_SCHEMA),
        outputSchema: {
          status: 200,
          envelope: 'standard',
          contentTypes: ['application/json'],
          data: SECURITY_UNIVERSAL_INGEST_OUTPUT_SCHEMA,
        },
        examples: [
          {
            description: 'Record one custom tool execution event',
            request: {
              action: 'execute',
              module: SECURITY_PROGRESSIVE_MODULE,
              operation: 'recordSecurityEvents',
              params: {
                sourceName: 'capability-workbench',
                sourceType: 'custom',
                workspacePath: 'repo://payments',
                agentId: 'capability-agent',
                sessionId: 'session-1',
                events: [
                  {
                    at: '2026-07-01T00:00:00.000Z',
                    eventKind: 'ToolExec',
                    eventCategory: 'tool',
                    subject: 'capability workbench sample event',
                    command: ['bash', '-lc', 'id'],
                    verdict: 'allow',
                    severity: 'low',
                  },
                ],
              },
            },
          },
        ],
      },
      {
        name: 'buildEvidenceBundle',
        operationId: 'buildEvidenceBundle',
        description: 'Build a governance evidence bundle around an event, run, trace, incident, objective, source, or scope.',
        method: 'POST',
        path: '/security-center/capabilities',
        resource: 'security-center.evidence',
        action: 'get',
        tags: ['security-center', 'evidence', 'progressive-api'],
        parameters: [
          { name: 'eventId', in: 'body', type: 'string', required: false, description: 'Event id to center the evidence bundle on.' },
          { name: 'runId', in: 'body', type: 'string', required: false, description: 'Run id to center the evidence bundle on.' },
          { name: 'scope', in: 'body', type: 'string', required: false, description: 'Bundle scope.' },
        ],
        inputSchema: progressiveExecuteInputSchema('buildEvidenceBundle', SECURITY_EVIDENCE_BUNDLE_PARAMS_SCHEMA),
        outputSchema: {
          status: 200,
          envelope: 'standard',
          contentTypes: ['application/json'],
          data: SECURITY_EVIDENCE_BUNDLE_OUTPUT_SCHEMA,
        },
        examples: [
          {
            description: 'Build a workspace evidence bundle',
            request: {
              action: 'execute',
              module: SECURITY_PROGRESSIVE_MODULE,
              operation: 'buildEvidenceBundle',
              params: { timeType: 'last_3h', workspacePath: 'repo://payments', limit: 20 },
            },
          },
        ],
      },
      {
        name: 'planNextActions',
        operationId: 'planNextActions',
        description: 'Return a ranked, evidence-linked action plan that an AI operator can execute or hand off.',
        method: 'POST',
        path: '/security-center/capabilities',
        resource: 'security-center.remediation',
        action: 'execute',
        tags: ['security-center', 'remediation', 'agent-plan', 'progressive-api'],
        parameters: [
          { name: 'timeType', in: 'body', type: 'string', required: false, description: 'last_3h/last_1d/last_7d/last_30d/custom.' },
          { name: 'workspacePath', in: 'body', type: 'string', required: false, description: 'Limit the plan to one workspace.' },
          { name: 'agentId', in: 'body', type: 'string', required: false, description: 'Limit the plan to one agent.' },
          { name: 'maxActions', in: 'body', type: 'number', required: false, description: 'Maximum actions to return; default 5, max 20.' },
        ],
        inputSchema: progressiveExecuteInputSchema('planNextActions', SECURITY_NEXT_ACTION_PLAN_PARAMS_SCHEMA),
        outputSchema: {
          status: 200,
          envelope: 'standard',
          contentTypes: ['application/json'],
          data: SECURITY_NEXT_ACTION_PLAN_OUTPUT_SCHEMA,
        },
        examples: [
          {
            description: 'Ask AnySentry for the next three actions in one workspace',
            request: {
              action: 'execute',
              module: SECURITY_PROGRESSIVE_MODULE,
              operation: 'planNextActions',
              params: { timeType: 'last_1d', workspacePath: 'prod/payments', maxActions: 3 },
            },
          },
        ],
      },
    ],
  },
];

function securityCapabilityAction(value: unknown): T.SecurityCapabilityAction {
  const action = cleanString(value, 40) as T.SecurityCapabilityAction | undefined;
  if (!action) return 'list';
  if (SECURITY_CAPABILITY_ACTIONS.includes(action)) return action;
  throw new BadRequestException(`Unknown capability action: ${action}`);
}

function securityCapabilityShaped(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

function securityCapabilityResponse(
  action: T.SecurityCapabilityAction,
  data: Omit<T.SecurityCapabilityResponse, 'schemaVersion' | 'protocol' | 'action' | 'compatibility'>,
): T.SecurityCapabilityResponse {
  return {
    schemaVersion: 'anysentry.progressive.response.v1',
    protocol: 'shuanos-progressive-api/source-compatible',
    action,
    ...data,
    compatibility: {
      sourceImplementation: 'os/apps/api/src/modules/kernel',
      dispatch: 'module + operation + params',
      supportedActions: SECURITY_CAPABILITY_ACTIONS,
      shapedOptIn: true,
      legacyCapabilityAliases: SECURITY_PROGRESSIVE_ALIASES,
    },
  };
}

function schemaIssue(path: string, message: string): T.SecurityCapabilitySchemaIssue {
  return { path, message, severity: 'error' };
}

function schemaPath(parent: string, key: string | number): string {
  return typeof key === 'number' ? `${parent}[${key}]` : `${parent}.${key}`;
}

function schemaTypeName(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function schemaTypeMatches(expected: unknown, value: unknown): boolean {
  const expectedTypes = Array.isArray(expected) ? expected : [expected];
  const actual = schemaTypeName(value);
  return expectedTypes.some((type) => type === actual || (type === 'number' && actual === 'integer'));
}

function sameSchemaValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSecurityCapabilitySchema(schema: unknown, value: unknown, path = '$'): T.SecurityCapabilitySchemaIssue[] {
  const item = obj(schema);
  if (!item) return [];
  const oneOf = Array.isArray(item.oneOf) ? item.oneOf : undefined;
  if (oneOf) {
    const matches = oneOf.filter((child) => validateSecurityCapabilitySchema(child, value, path).length === 0).length;
    return matches === 1 ? [] : [schemaIssue(path, 'must match exactly one schema')];
  }
  const anyOf = Array.isArray(item.anyOf) ? item.anyOf : undefined;
  if (anyOf) {
    const matches = anyOf.filter((child) => validateSecurityCapabilitySchema(child, value, path).length === 0).length;
    if (matches === 0) return [schemaIssue(path, 'must match at least one schema')];
  }

  const issues: T.SecurityCapabilitySchemaIssue[] = [];
  if ('const' in item && !sameSchemaValue(value, item.const)) issues.push(schemaIssue(path, `must equal ${JSON.stringify(item.const)}`));
  if (Array.isArray(item.enum) && !item.enum.some((entry) => sameSchemaValue(entry, value))) issues.push(schemaIssue(path, `must be one of ${item.enum.join(', ')}`));
  if (item.type && !schemaTypeMatches(item.type, value)) {
    issues.push(schemaIssue(path, `must be ${Array.isArray(item.type) ? item.type.join(' or ') : item.type}`));
    return issues;
  }

  if (Array.isArray(value)) {
    if (typeof item.minItems === 'number' && value.length < item.minItems) issues.push(schemaIssue(path, `must contain at least ${item.minItems} items`));
    if (typeof item.maxItems === 'number' && value.length > item.maxItems) issues.push(schemaIssue(path, `must contain at most ${item.maxItems} items`));
    value.forEach((child, index) => issues.push(...validateSecurityCapabilitySchema(item.items, child, schemaPath(path, index))));
  }

  const valueObject = obj(value);
  if (valueObject) {
    const properties = obj(item.properties) ?? {};
    const required = Array.isArray(item.required) ? item.required.filter((key): key is string => typeof key === 'string') : [];
    for (const key of required) {
      if (!(key in valueObject)) issues.push(schemaIssue(schemaPath(path, key), 'is required'));
    }
    for (const [key, child] of Object.entries(valueObject)) {
      if (key in properties) {
        issues.push(...validateSecurityCapabilitySchema(properties[key], child, schemaPath(path, key)));
      } else if (item.additionalProperties === false) {
        issues.push(schemaIssue(schemaPath(path, key), 'is not allowed'));
      } else if (obj(item.additionalProperties)) {
        issues.push(...validateSecurityCapabilitySchema(item.additionalProperties, child, schemaPath(path, key)));
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof item.minimum === 'number' && value < item.minimum) issues.push(schemaIssue(path, `must be at least ${item.minimum}`));
    if (typeof item.maximum === 'number' && value > item.maximum) issues.push(schemaIssue(path, `must be at most ${item.maximum}`));
  }
  if (typeof value === 'string') {
    if (typeof item.minLength === 'number' && value.length < item.minLength) issues.push(schemaIssue(path, `must be at least ${item.minLength} characters`));
    if (typeof item.maxLength === 'number' && value.length > item.maxLength) issues.push(schemaIssue(path, `must be at most ${item.maxLength} characters`));
  }
  return issues;
}

function cloneSecurityModule(module: T.SecurityApiModule): T.SecurityApiModule {
  return JSON.parse(JSON.stringify(module)) as T.SecurityApiModule;
}

function securityModules(input: Pick<T.SecurityCapabilityRequest, 'category'> = {}): T.SecurityApiModule[] {
  const category = cleanString(input.category, 120)?.toLowerCase();
  return SECURITY_PROGRESSIVE_MODULES.map(cloneSecurityModule).map((module) => ({
    ...module,
    operations: module.operations?.filter((operation) => !category || operation.tags?.some((tag) => tag.toLowerCase() === category)),
  })).filter((module) => (module.operations?.length ?? 0) > 0);
}

function securityCapabilitySearch(query: unknown): T.SecurityApiOperation[] {
  const terms = cleanString(query, 400)?.toLowerCase().split(/[^a-z0-9_.-]+/).filter(Boolean) ?? [];
  if (terms.length === 0) throw new BadRequestException('query parameter is required for search action');
  return securityModules()
    .flatMap((module) => module.operations ?? [])
    .map((operation) => {
      const text = [
        operation.name,
        operation.operationId,
        operation.description,
        operation.resource,
        operation.action,
        operation.path,
        ...(operation.tags ?? []),
      ]
        .join(' ')
        .toLowerCase();
      const score = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
      return { operation, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.operation.name.localeCompare(b.operation.name))
    .map(({ operation }) => operation);
}

function normalizeSecurityCapabilityInput(input: T.SecurityCapabilityRequest): T.SecurityCapabilityRequest {
  const capabilityId = cleanString(input.capabilityId, 180);
  const alias = capabilityId ? SECURITY_PROGRESSIVE_ALIASES[capabilityId] : undefined;
  const legacyOperation = cleanString(input.operation, 180);
  return {
    ...input,
    module: cleanString(input.module, 180) ?? alias?.module,
    operation:
      alias && (!legacyOperation || legacyOperation === 'assessAction' || legacyOperation === 'recordEvents' || legacyOperation === 'buildBundle')
        ? alias.operation
        : legacyOperation,
  };
}

function findSecurityModule(moduleName: unknown): T.SecurityApiModule {
  const name = cleanString(moduleName, 180);
  if (!name) throw new BadRequestException('module parameter is required');
  const module = securityModules().find((candidate) => candidate.name === name);
  if (!module) throw new NotFoundException(`Module '${name}' not found`);
  return module;
}

function findSecurityOperation(module: T.SecurityApiModule, operationName: unknown): T.SecurityApiOperation {
  const operation = cleanString(operationName, 180);
  if (!operation) throw new BadRequestException('operation is required');
  const found = module.operations?.find((candidate) => candidate.name === operation || candidate.operationId === operation);
  if (!found) throw new NotFoundException(`Operation '${operation}' not found in module '${module.name}'`);
  return found;
}

function securityCapabilityAutonomy(value: unknown): T.SecurityCapabilityAutonomy {
  const mode = cleanString(value, 40) as T.SecurityCapabilityAutonomy | undefined;
  return mode && SECURITY_CAPABILITY_AUTONOMY.includes(mode) ? mode : 'guarded';
}

function securityCapabilityStage(value: unknown): T.SecurityCapabilityStage {
  const stage = cleanString(value, 60)?.toLowerCase().replace(/[\s.-]+/g, '_');
  const aliases: Record<string, T.SecurityCapabilityStage> = {
    prompt: 'input',
    planning: 'plan',
    tool_call: 'tool',
    function_call: 'tool',
    action: 'tool',
    rag: 'retrieval',
    retrieve: 'retrieval',
    vector_search: 'retrieval',
    memory_read: 'memory',
    memory_write: 'memory',
    model: 'llm',
    completion: 'llm',
    response: 'output',
    final_answer: 'output',
    eval: 'feedback',
    telemetry: 'runtime',
  };
  if (stage && aliases[stage]) return aliases[stage];
  return stage && SECURITY_CAPABILITY_STAGES.includes(stage as T.SecurityCapabilityStage) ? (stage as T.SecurityCapabilityStage) : 'runtime';
}

function securityCapabilityCommand(body: T.SecurityRuntimeGuardParams): string[] | undefined {
  const command = body.command ?? body.action ?? body.toolName;
  if (Array.isArray(command)) return command.map((item) => cleanString(item, 200)).filter((item): item is string => Boolean(item));
  const text = cleanString(command, 600);
  if (!text) return undefined;
  const args = text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, ''));
  return args?.length ? args : [text];
}

function securityCapabilityJsonAttribute(value: unknown, limit = 700): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return cleanString(value, limit);
  return cleanString(JSON.stringify(value), limit);
}

function securityCapabilityAttributes(
  body: T.SecurityRuntimeGuardParams,
  autonomy: T.SecurityCapabilityAutonomy,
  stage: T.SecurityCapabilityStage,
): Record<string, T.EventAttributeValue> {
  const attrs: Record<string, T.EventAttributeValue> = {
    'progressive.protocol': 'shuanos-progressive-api/source-compatible',
    'progressive.module': SECURITY_PROGRESSIVE_MODULE,
    'progressive.operation': 'assessRuntimeAction',
    'progressive.autonomy': autonomy,
    'progressive.stage': stage,
    ...sanitizeEventAttributes(body.attributes),
    ...sanitizeEventAttributes(body.labels),
  };
  const toolArgs = securityCapabilityJsonAttribute(body.toolArgs);
  const evidence = securityCapabilityJsonAttribute(body.evidence, 1_000);
  const model = cleanString(body.model, 180);
  const target = cleanString(body.target ?? body.resource, 700);
  if (toolArgs) attrs['progressive.toolArgs'] = toolArgs;
  if (evidence) attrs['progressive.evidence'] = evidence;
  if (model) attrs['progressive.model'] = model;
  if (target) attrs['progressive.target'] = target;
  return attrs;
}

function securityRuntimeGuardEvent(
  body: T.SecurityRuntimeGuardParams,
  autonomy: T.SecurityCapabilityAutonomy,
  stage: T.SecurityCapabilityStage,
): T.UniversalIngestEvent {
  const command = securityCapabilityCommand(body);
  const content = cleanString(body.output ?? body.prompt ?? body.input ?? body.subject, 1_000);
  const target = cleanString(body.target ?? body.resource, 700);
  const model = cleanString(body.model, 180);
  const base: T.UniversalIngestEvent = {
    workspacePath: cleanString(body.workspacePath, 500),
    agentId: cleanString(body.agentId, 240),
    sessionId: cleanString(body.sessionId, 240),
    userId: cleanString(body.userId, 240),
    traceId: cleanString(body.traceId, 240),
    spanId: cleanString(body.spanId, 240),
    parentSpanId: cleanString(body.parentSpanId, 240),
    runId: cleanString(body.runId, 240),
    taskId: cleanString(body.taskId, 240),
    collectorId: cleanString(body.collectorId, 180),
    source: 'api',
    attributes: securityCapabilityAttributes(body, autonomy, stage),
    rawPreview: sanitizeRawPreview({ ...body, token: undefined }),
  };
  if (stage === 'tool') {
    return {
      ...base,
      kind: 'tool',
      argv: command ?? [cleanString(body.toolName ?? body.action, 200) ?? 'security-runtime-tool'],
      subject: cleanString(body.subject ?? body.action ?? body.toolName, 500) ?? 'security runtime tool action',
    };
  }
  if (stage === 'retrieval' || stage === 'memory') {
    return {
      ...base,
      kind: target?.startsWith('/') ? 'file' : 'egress',
      path: target?.startsWith('/') ? target : undefined,
      peer: target && !target.startsWith('/') ? target : undefined,
      subject: cleanString(body.subject ?? target, 500) ?? `security runtime ${stage}`,
    };
  }
  if (stage === 'llm') {
    return {
      ...base,
      kind: 'llm_api',
      endpoint: target ?? model ?? 'llm',
      content,
      subject: cleanString(body.subject ?? model ?? target, 500) ?? 'security runtime llm call',
      tokenCount: finiteNumber(body.tokenCount),
    };
  }
  return {
    ...base,
    kind: 'ssl_content',
    content: content ?? cleanString(body.action ?? body.output, 1_000) ?? '',
    subject: cleanString(body.subject ?? body.action ?? stage, 500) ?? `security runtime ${stage}`,
  };
}

type RuntimeGuardFallbackRisk = {
  policyAction: Exclude<T.SecurityCapabilityPolicyAction, 'allow'>;
  severity: T.Severity;
  riskCategory: string;
  reason: string;
};

const RUNTIME_GUARD_FALLBACK_PATTERNS: Array<{ pattern: RegExp; risk: RuntimeGuardFallbackRisk }> = [
  {
    pattern: /\b169\.254\.169\.254\b|metadata\.google\.internal|metadata\.azure\.com/iu,
    risk: {
      policyAction: 'block',
      severity: 'critical',
      riskCategory: 'systemic_risk',
      reason: 'runtime guard detected cloud metadata service access',
    },
  },
  {
    pattern: /\bcurl\b[\s\S]*\|[\s\S]*(?:\bsh\b|\bbash\b)|\bwget\b[\s\S]*\|[\s\S]*(?:\bsh\b|\bbash\b)|base64\s+-d[\s\S]*\|[\s\S]*(?:\bsh\b|\bbash\b)/iu,
    risk: {
      policyAction: 'block',
      severity: 'critical',
      riskCategory: 'command_danger',
      reason: 'runtime guard detected piped remote-code execution',
    },
  },
  {
    pattern: /\brm\s+-[^\s]*r[^\s]*f[^\s]*(?:\s+--no-preserve-root)?\s+(?:\/|\$HOME|~)(?:\s|$)/iu,
    risk: {
      policyAction: 'block',
      severity: 'critical',
      riskCategory: 'command_danger',
      reason: 'runtime guard detected destructive recursive deletion',
    },
  },
  {
    pattern: /\b(?:ncat|nc|netcat|socat)\b[\s\S]*(?:\s-e\s|exec:|\/bin\/(?:sh|bash))/iu,
    risk: {
      policyAction: 'block',
      severity: 'critical',
      riskCategory: 'communication_risk',
      reason: 'runtime guard detected reverse-shell style command',
    },
  },
  {
    pattern: /(?:^|\s)(?:\/etc\/shadow|\/etc\/sudoers|[^\s]*\.aws\/credentials|[^\s]*\.ssh\/id_(?:rsa|ed25519)|[^\s]*\.kube\/config)(?:\s|$)/iu,
    risk: {
      policyAction: 'block',
      severity: 'high',
      riskCategory: 'data_leak',
      reason: 'runtime guard detected credential or privileged file access',
    },
  },
];

function securityRuntimeGuardSearchText(body: T.SecurityRuntimeGuardParams, event: T.UniversalIngestEvent): string {
  const command = securityCapabilityCommand(body);
  return [
    Array.isArray(command) ? command.join(' ') : undefined,
    Array.isArray(event.argv) ? event.argv.join(' ') : undefined,
    typeof event.command === 'string' ? event.command : undefined,
    body.action,
    body.toolName,
    body.target,
    body.resource,
    body.input,
    body.prompt,
    body.output,
    body.model,
    body.subject,
  ]
    .map((value) => cleanString(value, 1_000))
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

function securityRuntimeGuardFallbackRisk(
  body: T.SecurityRuntimeGuardParams,
  event: T.UniversalIngestEvent,
): RuntimeGuardFallbackRisk | undefined {
  const text = securityRuntimeGuardSearchText(body, event);
  if (!text) return undefined;
  return RUNTIME_GUARD_FALLBACK_PATTERNS.find((entry) => entry.pattern.test(text))?.risk;
}

function policyActionRank(action: T.SecurityCapabilityPolicyAction): number {
  if (action === 'block') return 3;
  if (action === 'require_approval') return 2;
  if (action === 'warn') return 1;
  return 0;
}

function strongestPolicyAction(left: T.SecurityCapabilityPolicyAction, right: T.SecurityCapabilityPolicyAction): T.SecurityCapabilityPolicyAction {
  return policyActionRank(left) >= policyActionRank(right) ? left : right;
}

function fallbackRiskPolicyAction(
  autonomy: T.SecurityCapabilityAutonomy,
  risk: RuntimeGuardFallbackRisk | undefined,
): T.SecurityCapabilityPolicyAction | undefined {
  if (!risk) return undefined;
  if (autonomy === 'suggest') return 'warn';
  if (autonomy === 'guarded') return risk.policyAction === 'block' ? 'require_approval' : 'warn';
  return risk.policyAction;
}

function securityCapabilityPolicyAction(
  autonomy: T.SecurityCapabilityAutonomy,
  item: T.UniversalIngestResultItem | undefined,
  fallbackRisk?: RuntimeGuardFallbackRisk,
): T.SecurityCapabilityPolicyAction {
  if (!item?.accepted) return 'block';
  let action: T.SecurityCapabilityPolicyAction = 'allow';
  if (item.verdict !== 'allow') {
    if (autonomy === 'suggest') action = 'warn';
    else if (autonomy === 'guarded') action = item.verdict === 'block' ? 'require_approval' : 'warn';
    else action = item.verdict === 'block' ? 'block' : 'warn';
  }
  const fallbackAction = fallbackRiskPolicyAction(autonomy, fallbackRisk);
  return fallbackAction ? strongestPolicyAction(action, fallbackAction) : action;
}

function securityRuntimeGuardFallbackEvent(
  body: T.SecurityRuntimeGuardParams,
  event: T.UniversalIngestEvent,
  risk: RuntimeGuardFallbackRisk,
  autonomy: T.SecurityCapabilityAutonomy,
  stage: T.SecurityCapabilityStage,
  actionEventId: string | undefined,
  actionTraceId: string | undefined,
  actionSpanId: string | undefined,
): T.UniversalIngestEvent {
  const fallbackSpanId = `sp_guard_${createHash('sha1')
    .update(actionEventId ?? '')
    .update('\0')
    .update(cleanString(body.runId, 240) ?? '')
    .update('\0')
    .update(risk.reason)
    .digest('hex')
    .slice(0, 16)}`;
  return {
    workspacePath: cleanString(body.workspacePath, 500),
    agentId: cleanString(body.agentId, 240),
    sessionId: cleanString(body.sessionId, 240),
    userId: cleanString(body.userId, 240),
    traceId: cleanString(actionTraceId ?? body.traceId, 240),
    spanId: fallbackSpanId,
    parentSpanId: cleanString(actionSpanId ?? body.parentSpanId, 240),
    runId: cleanString(body.runId, 240),
    taskId: cleanString(body.taskId, 240),
    collectorId: cleanString(body.collectorId, 180),
    source: 'api',
    kind: 'SecurityFinding',
    status: 'failed',
    subject: `runtime guard fallback: ${risk.reason}`,
    attributes: {
      ...securityCapabilityAttributes(body, autonomy, stage),
      'progressive.guard.fallback': true,
      'progressive.guard.reason': risk.reason,
      'progressive.guard.riskCategory': risk.riskCategory,
      'progressive.guard.riskName': 'Runtime guard fallback',
      'progressive.guard.severity': risk.severity,
      'progressive.guard.policyAction': risk.policyAction,
      ...(actionEventId ? { 'progressive.guard.actionEventId': actionEventId } : {}),
    },
    rawPreview: sanitizeRawPreview({ ...body, token: undefined, event }),
  };
}

function securityCapabilityRecommendedAction(policyAction: T.SecurityCapabilityPolicyAction): T.SecurityRuntimeGuardDecision['recommendedAction'] {
  if (policyAction === 'block') return 'stop';
  if (policyAction === 'require_approval' || policyAction === 'warn') return 'review';
  return 'continue';
}

function securityRuntimeGuardParams(value: unknown): T.SecurityRuntimeGuardParams {
  const params = obj(value);
  if (!params) throw new BadRequestException('params object is required for security.runtimeGuard assessAction');
  return params as T.SecurityRuntimeGuardParams;
}

function securityNextActionPlanParams(value: unknown): T.SecurityNextActionPlanParams {
  return (obj(value) ?? {}) as T.SecurityNextActionPlanParams;
}

const NEXT_ACTION_SEVERITY_RANK: Record<T.Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const NEXT_ACTION_STATUS_RANK: Record<T.RemediationStatus, number> = {
  open: 4,
  blocked: 3,
  in_progress: 2,
  done: 1,
  dismissed: 0,
};

function actionPriority(severity: T.Severity): T.SecurityNextActionPlanItem['priority'] {
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  return 'low';
}

function parseIsoish(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nextActionPrimaryType(task: T.RemediationListItem): T.EvidenceBundlePrimaryType {
  if (task.incidentId) return 'incident';
  if (task.alertId) return 'alert';
  if (task.sourceType === 'coverage') return 'coverage';
  return 'remediation';
}

function nextActionPrimaryId(task: T.RemediationListItem, primaryType: T.EvidenceBundlePrimaryType): string {
  if (primaryType === 'incident') return task.incidentId ?? task.taskId;
  if (primaryType === 'alert') return task.alertId ?? task.taskId;
  if (primaryType === 'coverage') return task.labels?.issueId ?? task.sourceId;
  return task.taskId;
}

function nextActionBundleHint(task: T.RemediationListItem): T.EvidenceBundleQuery {
  if (task.eventId) return { eventId: task.eventId };
  if (task.incidentId) return { incidentId: task.incidentId };
  if (task.alertId) return { alertId: task.alertId };
  if (task.labels?.objectiveId) return { objectiveId: task.labels.objectiveId };
  if (task.sourceType === 'coverage') return { issueId: task.labels?.issueId ?? task.sourceId };
  return { taskId: task.taskId };
}

function nextActionNeedsApproval(task: T.RemediationListItem, overdue: boolean): boolean {
  return (
    task.severity === 'critical' ||
    task.actionKind === 'credential' ||
    task.actionKind === 'policy' ||
    task.actionKind === 'network' ||
    (task.status === 'blocked' && (task.severity === 'high' || overdue))
  );
}

function nextActionPlanItem(
  task: T.RemediationListItem,
  rank: number,
  includeCompletedSteps: boolean,
  now = Date.now(),
): T.SecurityNextActionPlanItem {
  const dueAt = parseIsoish(task.dueAt);
  const overdue = Boolean(dueAt && dueAt < now && task.status !== 'done' && task.status !== 'dismissed');
  const primaryType = nextActionPrimaryType(task);
  const primaryId = nextActionPrimaryId(task, primaryType);
  const objectiveId = task.labels?.objectiveId;
  const issueId = task.sourceType === 'coverage' ? task.labels?.issueId ?? task.sourceId : task.labels?.issueId;
  const nextSteps = includeCompletedSteps ? task.steps : task.steps.filter((step) => !step.done);
  return {
    actionId: `act_${rank}_${task.taskId}`,
    taskId: task.taskId,
    rank,
    priority: actionPriority(task.severity),
    status: task.status,
    severity: task.severity,
    title: task.title,
    recommendedAction: task.recommendedAction,
    actionKind: task.actionKind,
    sourceType: task.sourceType,
    sourceId: task.sourceId,
    owner: task.owner,
    dueAt: task.dueAt,
    overdue,
    needsApproval: nextActionNeedsApproval(task, overdue),
    agentId: task.agentId,
    workspacePath: task.workspacePath,
    collectorId: task.collectorId,
    sourceIdentity: task.ingestionSourceId,
    eventId: task.eventId,
    traceId: task.traceId,
    objectiveId,
    issueId,
    evidence: {
      primaryType,
      primaryId,
      eventId: task.eventId,
      incidentId: task.incidentId,
      alertId: task.alertId,
      taskId: task.taskId,
      objectiveId,
      issueId,
      bundleHint: nextActionBundleHint(task),
    },
    nextSteps,
  };
}

function otlpRawAnyValue(value: unknown): unknown {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  const wrapped = obj(value);
  if (!wrapped) return value;
  if (Object.prototype.hasOwnProperty.call(wrapped, 'stringValue')) return wrapped.stringValue;
  for (const key of ['intValue', 'doubleValue', 'boolValue']) {
    if (Object.prototype.hasOwnProperty.call(wrapped, key)) {
      // OTLP JSON commonly represents intValue as JSON text. Preserve its typed origin so a
      // numeric claim cannot be mistaken for a producer-supplied identity string.
      return { otlpType: key, value: wrapped[key] };
    }
  }
  return value;
}

function otlpRawAttributes(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const attrs: Record<string, unknown> = {};
    for (const item of value.slice(0, 200)) {
      const rec = obj(item);
      const key = cleanString(rec?.key, 120);
      if (!key || otlpAnyValue(rec?.value, key) === undefined) continue;
      attrs[key] = otlpRawAnyValue(rec?.value);
    }
    return attrs;
  }
  return rawNormalizedEventAttributes(value);
}

function firstRawAttribute(attrs: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(attrs, key)) return attrs[key];
  }
  return undefined;
}

function selectedRawAttribute(
  rawAttrs: Record<string, unknown>,
  normalizedAttrs: Record<string, T.EventAttributeValue>,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    if (normalizedAttrs[key] == null || !cleanString(normalizedAttrs[key], 700)) continue;
    // A normalized identity without its raw producer value cannot be trusted. Returning a
    // non-string sentinel makes downstream strict identity validation fail closed.
    return Object.prototype.hasOwnProperty.call(rawAttrs, key) ? rawAttrs[key] : { rawUnavailable: true };
  }
  return undefined;
}

function rawDerivedOtlpWorkspace(
  body: T.UniversalIngestRequest & Record<string, unknown>,
  rawResourceAttrs: Record<string, unknown>,
  resourceAttrs: Record<string, T.EventAttributeValue>,
  rawItemAttrs: Record<string, unknown>,
  itemAttrs: Record<string, T.EventAttributeValue>,
): unknown {
  if (body.workspacePath !== undefined && body.workspacePath !== null) return body.workspacePath;
  const explicit = selectedRawAttribute(rawResourceAttrs, resourceAttrs, 'anysentry.workspace');
  if (explicit !== undefined) return explicit;
  const namespace = selectedRawAttribute(
    rawResourceAttrs,
    resourceAttrs,
    'service.namespace',
    'k8s.namespace.name',
    'deployment.environment.name',
  );
  const service = selectedRawAttribute(
    rawResourceAttrs,
    resourceAttrs,
    'anysentry.agent.id',
    'agent.id',
    'service.name',
    'k8s.pod.name',
    'process.executable.name',
  );
  const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined;
  const namespaceText = text(namespace);
  const serviceText = text(service);
  if (namespace !== undefined && !namespaceText) return namespace;
  if (service !== undefined && !serviceText) return service;
  if (namespaceText && serviceText) return `${namespaceText}/${serviceText}`;
  if (namespaceText) return `workspace://${namespaceText}`;
  if (serviceText) return `service://${serviceText}`;
  const itemWorkspace = selectedRawAttribute(rawItemAttrs, itemAttrs, 'anysentry.workspace');
  if (itemWorkspace !== undefined) return itemWorkspace;
  const combinedRaw = { ...rawResourceAttrs, ...rawItemAttrs };
  const combined = { ...resourceAttrs, ...itemAttrs };
  const cwd = selectedRawAttribute(combinedRaw, combined, 'process.working_directory');
  if (cwd !== undefined) return cwd;
  const agent = body.agentId ?? selectedRawAttribute(
    combinedRaw,
    combined,
    'anysentry.agent.id',
    'agent.id',
    'service.name',
    'k8s.pod.name',
  );
  return rawAgentWorkspace(agent);
}

function otlpRawCorrelationClaims(
  body: T.UniversalIngestRequest & Record<string, unknown>,
  resourceAttrs: Record<string, unknown>,
  normalizedResourceAttrs: Record<string, T.EventAttributeValue>,
  itemAttrs: Record<string, unknown>,
  normalizedItemAttrs: Record<string, T.EventAttributeValue>,
  record: Record<string, unknown>,
): RawProducerCorrelationClaims {
  const combined = { ...resourceAttrs, ...itemAttrs };
  const resourceService = selectedRawAttribute(
    resourceAttrs,
    normalizedResourceAttrs,
    'anysentry.agent.id',
    'agent.id',
    'service.name',
    'k8s.pod.name',
    'process.executable.name',
  );
  const resourceSession = body.sessionId ?? body.conversationId ?? body.threadId ?? selectedRawAttribute(
    resourceAttrs,
    normalizedResourceAttrs,
    'anysentry.session.id',
    'gen_ai.conversation.id',
    'conversation.id',
    'conversation_id',
    'thread.id',
    'thread_id',
    'session.id',
  );
  return {
    invocationId: firstRawAttribute(
      combined,
      'anysentry.invocation.id',
      'gen_ai.invocation.id',
      'gen_ai.request.id',
    ) ?? body.invocationId,
    toolCallId: firstRawAttribute(
      combined,
      'anysentry.tool_call.id',
      'anysentry.tool.call.id',
      'gen_ai.tool.call.id',
      'tool_call.id',
    ) ?? body.toolCallId,
    runId: firstRawAttribute(
      combined,
      'anysentry.run.id',
      'anysentry.run_id',
      'runId',
      'run.id',
      'gen_ai.run.id',
      'workflow_run_id',
      'langgraph.run_id',
    ) ?? body.runId,
    traceId: record.traceId ?? body.traceId ?? body.traceparent,
    sessionId: resourceSession ?? firstRawAttribute(
      combined,
      'anysentry.session.id',
      'gen_ai.conversation.id',
      'conversation.id',
      'conversation_id',
      'thread.id',
      'thread_id',
      'session.id',
    ),
    workspacePath: rawDerivedOtlpWorkspace(
      body,
      resourceAttrs,
      normalizedResourceAttrs,
      itemAttrs,
      normalizedItemAttrs,
    ),
    collectorId: body.collectorId ?? selectedRawAttribute(
      resourceAttrs,
      normalizedResourceAttrs,
      'anysentry.collector.id',
      'collector.id',
      'host.name',
    ),
    attributes: {
      ...rawNormalizedEventAttributes(body.attributes),
      // Resource and item maps already mirror the OTLP array/object limits and normalized keys.
      // Applying the generic 120-entry limit again would hide explicitly supplied late claims.
      ...combined,
    },
    attribution: body.attribution,
  };
}

function otlpAnyValue(value: unknown, key?: string): T.EventAttributeValue | undefined {
  if (key && sensitiveAttributeKey(key)) return '[redacted]';
  if (typeof value === 'string') {
    const normalized = attrValue(value, key);
    return typeof normalized === 'string' ? normalized.slice(0, 500) : normalized;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const wrapped = obj(value);
  if (!wrapped) return undefined;
  for (const valueKind of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) {
    if (!(valueKind in wrapped)) continue;
    const raw = wrapped[valueKind];
    if (valueKind === 'boolValue') return Boolean(raw);
    if (valueKind === 'stringValue') {
      const normalized = attrValue(raw, key);
      return typeof normalized === 'string' ? normalized.slice(0, 500) : normalized;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (wrapped.arrayValue || wrapped.kvlistValue) return cleanString(JSON.stringify(wrapped), 500);
  return undefined;
}

function otlpAttributes(value: unknown): Record<string, T.EventAttributeValue> {
  if (Array.isArray(value)) {
    const attrs: Record<string, T.EventAttributeValue> = {};
    for (const item of value.slice(0, 200)) {
      const rec = obj(item);
      const key = cleanString(rec?.key, 120);
      if (!key) continue;
      const v = otlpAnyValue(rec?.value, key);
      if (v !== undefined) attrs[key] = v;
    }
    return attrs;
  }
  return sanitizeEventAttributes(value);
}

function attrText(attrs: Record<string, T.EventAttributeValue>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (value == null) continue;
    const text = cleanString(value, 700);
    if (text) return text;
  }
  return undefined;
}

function attrNumber(attrs: Record<string, T.EventAttributeValue>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const n = finiteNumber(attrs[key]);
    if (n !== undefined) return n;
  }
  return undefined;
}

function otlpTimeMs(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value == null || value === '') continue;
    const raw = typeof value === 'bigint' ? Number(value) : Number(value);
    if (Number.isFinite(raw)) return raw > 10_000_000_000_000 ? Math.floor(raw / 1_000_000) : raw > 10_000_000_000 ? Math.floor(raw) : Math.floor(raw * 1000);
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function otlpBodyText(body: unknown): string | undefined {
  const direct = otlpAnyValue(body);
  if (direct !== undefined) return cleanString(direct, 1_000);
  return cleanString(body, 1_000);
}

/** Only explicit conversation/thread/session attributes may define an OTLP Session. Runtime
 * service.instance/pod identifiers describe deployment/runtime scope and must never merge
 * otherwise stateless POST requests into one conversation. */
function otlpExplicitSessionId(attrs: Record<string, T.EventAttributeValue>): string | undefined {
  return attrText(
    attrs,
    'anysentry.session.id',
    'gen_ai.conversation.id',
    'conversation.id',
    'conversation_id',
    'thread.id',
    'thread_id',
    'session.id',
  );
}

function otlpDefaults(resourceAttrs: Record<string, T.EventAttributeValue>, body: T.UniversalIngestRequest): Partial<T.UniversalIngestRequest> {
  const service = attrText(resourceAttrs, 'anysentry.agent.id', 'agent.id', 'service.name', 'k8s.pod.name', 'process.executable.name');
  const namespace = attrText(resourceAttrs, 'anysentry.workspace', 'service.namespace', 'k8s.namespace.name', 'deployment.environment.name');
  const workspacePath = attrText(resourceAttrs, 'anysentry.workspace') ?? (namespace && service ? `${namespace}/${service}` : namespace ? `workspace://${namespace}` : service ? `service://${service}` : undefined);
  return {
    workspacePath: body.workspacePath ?? workspacePath,
    agentId: body.agentId ?? service,
    sessionId: body.sessionId ?? body.conversationId ?? body.threadId ?? otlpExplicitSessionId(resourceAttrs),
    userId: body.userId ?? attrText(resourceAttrs, 'enduser.id', 'user.id', 'user.name'),
    collectorId: body.collectorId ?? attrText(resourceAttrs, 'anysentry.collector.id', 'collector.id', 'host.name'),
    sourceName: body.sourceName ?? attrText(resourceAttrs, 'service.name'),
    sourceType: body.sourceType ?? 'otel',
  };
}

function universalFromOtelAttrs(
  attrs: Record<string, T.EventAttributeValue>,
  resourceAttrs: Record<string, T.EventAttributeValue>,
  item: Partial<T.UniversalIngestEvent>,
): T.UniversalIngestEvent {
  const combined = { ...resourceAttrs, ...attrs };
  const command = attrText(combined, 'anysentry.command', 'process.command_line', 'process.command', 'command', 'tool.command', 'db.statement');
  const endpoint = attrText(combined, 'anysentry.endpoint', 'server.address', 'net.peer.name', 'network.peer.address', 'peer.service', 'url.full', 'http.url', 'rpc.service', 'gen_ai.system', 'llm.provider');
  const filePath = attrText(combined, 'anysentry.file.path', 'file.path', 'log.file.path');
  const dnsQuery = attrText(combined, 'dns.question.name', 'dns.query');
  const content = attrText(combined, 'anysentry.content', 'gen_ai.prompt', 'llm.prompt', 'log.record.body');
  const explicitKind = attrText(combined, 'anysentry.event.kind', 'event.kind', 'event.name');
  const genAiOperation = attrText(combined, 'gen_ai.operation.name');
  const inferredKind =
    explicitKind ??
    (genAiOperation === 'execute_tool' ? 'AgentTool' : undefined) ??
    (genAiOperation === 'invoke_agent' ? 'AgentInvocation' : undefined) ??
    (command ? 'tool' : undefined) ??
    (filePath ? 'file' : undefined) ??
    (dnsQuery ? 'dns' : undefined) ??
    (attrText(combined, 'gen_ai.system', 'llm.model', 'llm.provider') ? 'llm_api' : undefined) ??
    (endpoint ? 'egress' : undefined) ??
    (content || item.subject ? 'ssl_content' : undefined);
  const tokenCount =
    attrNumber(combined, 'anysentry.token_count', 'llm.usage.total_tokens', 'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens') ??
    undefined;
  // Normalize standard OTLP resource/process identity into the aliases consumed by the common
  // EventMeta/process builder. Without this bridge an Adapter span carried only `pid`, so a later
  // Observer FileAccess/ToolExec fact could not pass the generation-safe same-process check.
  const processPid = attrNumber(combined, 'process.pid', 'pid');
  const processPpid = attrNumber(combined, 'process.ppid', 'ppid');
  const processHostId = attrText(combined, 'host.id', 'hostId', 'host.name');
  const processBootId = attrText(combined, 'host.boot_id', 'bootId', 'boot.id');
  const processStartTicks = attrText(combined, 'process.start_time_ticks', 'startTimeTicks', 'process.start_time');
  const processStartNs = attrText(combined, 'process.start_time_unix_nano', 'startTimeNs');
  const processCwd = attrText(combined, 'process.working_directory', 'cwd');
  const processComm = attrText(combined, 'process.executable.name', 'process.command_name', 'comm');
  const processCgroup = attrText(combined, 'container.id', 'process.cgroup', 'cgroup');
  const process = processPid !== undefined
    ? {
        pid: processPid,
        ...(processPpid !== undefined ? { ppid: processPpid } : {}),
        ...(processHostId ? { hostId: processHostId } : {}),
        ...(processBootId ? { bootId: processBootId } : {}),
        ...(processStartTicks ? { startTimeTicks: processStartTicks } : {}),
        ...(processStartNs ? { startTimeNs: processStartNs } : {}),
        ...(processCwd ? { cwd: processCwd } : {}),
        ...(processComm ? { comm: processComm } : {}),
        ...(processCgroup ? { cgroup: processCgroup } : {}),
      } satisfies T.ProcessContext
    : undefined;
  return {
    ...item,
    kind: inferredKind,
    eventKind: item.eventKind ?? inferredKind,
    agentId: item.agentId ?? attrText(combined, 'anysentry.agent.id', 'agent.id', 'service.name', 'k8s.pod.name'),
    workspacePath: item.workspacePath ?? attrText(combined, 'anysentry.workspace'),
    sessionId: item.sessionId ?? otlpExplicitSessionId(combined),
    invocationId: item.invocationId ?? attrText(combined, 'anysentry.invocation.id', 'gen_ai.invocation.id', 'gen_ai.request.id'),
    toolCallId: item.toolCallId ?? attrText(combined, 'anysentry.tool.call.id', 'anysentry.tool_call.id', 'gen_ai.tool.call.id', 'tool_call.id', 'tool.id'),
    runId: item.runId ?? attrText(combined, 'anysentry.run.id', 'anysentry.run_id', 'runId', 'run.id', 'gen_ai.run.id', 'workflow_run_id', 'langgraph.run_id'),
    userId: item.userId ?? attrText(combined, 'enduser.id', 'user.id', 'user.name'),
    command,
    peer: endpoint,
    endpoint,
    port: attrNumber(combined, 'server.port', 'net.peer.port', 'network.peer.port'),
    query: dnsQuery,
    path: filePath,
    sni: attrText(combined, 'tls.server.name', 'server.address', 'gen_ai.system'),
    cwd: attrText(combined, 'process.working_directory'),
    pid: attrNumber(combined, 'process.pid'),
    content: content ?? item.content,
    promptTokens: attrNumber(combined, 'llm.usage.prompt_tokens', 'gen_ai.usage.input_tokens'),
    completionTokens: attrNumber(combined, 'llm.usage.completion_tokens', 'gen_ai.usage.output_tokens'),
    tokenCount,
    ...(process ? { process } : {}),
    attributes: combined,
  };
}

function otlpToUniversal(body: T.UniversalIngestRequest & Record<string, unknown>): T.UniversalIngestRequest {
  const events: T.UniversalIngestEvent[] = [];
  const resourceLogs = Array.isArray(body.resourceLogs) ? body.resourceLogs : [];
  for (const resourceLog of resourceLogs) {
    const resource = obj(resourceLog)?.resource;
    const resourceAttrs = otlpAttributes(obj(resource)?.attributes);
    const rawResourceAttrs = otlpRawAttributes(obj(resource)?.attributes);
    const defaults = otlpDefaults(resourceAttrs, body);
    const scopes = (obj(resourceLog)?.scopeLogs ?? obj(resourceLog)?.instrumentationLibraryLogs) as unknown;
    for (const scopeLog of Array.isArray(scopes) ? scopes : []) {
      const records = obj(scopeLog)?.logRecords ?? obj(scopeLog)?.logs;
      for (const record of Array.isArray(records) ? records : []) {
        const rec = obj(record) ?? {};
        const attrs = otlpAttributes(rec.attributes);
        const rawAttrs = otlpRawAttributes(rec.attributes);
        const bodyText = otlpBodyText(rec.body);
        if (bodyText) attrs['log.record.body'] = bodyText;
        const event = universalFromOtelAttrs(attrs, resourceAttrs, {
          ...defaults,
          at: otlpTimeMs(rec.timeUnixNano, rec.observedTimeUnixNano),
          traceId: cleanString(rec.traceId, 240),
          spanId: cleanString(rec.spanId, 240),
          subject: bodyText ?? cleanString(rec.severityText, 240) ?? 'otel log',
          source: 'api',
        });
        events.push(bindRawUniversalCorrelationClaims(
          event,
          otlpRawCorrelationClaims(body, rawResourceAttrs, resourceAttrs, rawAttrs, attrs, rec),
        ));
      }
    }
  }

  const resourceSpans = Array.isArray(body.resourceSpans) ? body.resourceSpans : [];
  for (const resourceSpan of resourceSpans) {
    const resource = obj(resourceSpan)?.resource;
    const resourceAttrs = otlpAttributes(obj(resource)?.attributes);
    const rawResourceAttrs = otlpRawAttributes(obj(resource)?.attributes);
    const defaults = otlpDefaults(resourceAttrs, body);
    const scopes = (obj(resourceSpan)?.scopeSpans ?? obj(resourceSpan)?.instrumentationLibrarySpans) as unknown;
    for (const scopeSpan of Array.isArray(scopes) ? scopes : []) {
      const spans = obj(scopeSpan)?.spans;
      for (const span of Array.isArray(spans) ? spans : []) {
        const rec = obj(span) ?? {};
        const attrs = otlpAttributes(rec.attributes);
        const rawAttrs = otlpRawAttributes(rec.attributes);
        const startAt = otlpTimeMs(rec.startTimeUnixNano);
        const endAt = otlpTimeMs(rec.endTimeUnixNano);
        if (startAt !== undefined) attrs['anysentry.span.start_at_ms'] = startAt;
        if (endAt !== undefined) attrs['anysentry.span.end_at_ms'] = endAt;
        const event = universalFromOtelAttrs(attrs, resourceAttrs, {
          ...defaults,
          at: startAt ?? endAt,
          latencyMs: startAt !== undefined && endAt !== undefined && endAt >= startAt
            ? endAt - startAt
            : undefined,
          traceId: cleanString(rec.traceId, 240),
          spanId: cleanString(rec.spanId, 240),
          parentSpanId: cleanString(rec.parentSpanId, 240),
          subject: cleanString(rec.name, 500) ?? 'otel span',
          source: 'api',
        });
        events.push(bindRawUniversalCorrelationClaims(
          event,
          otlpRawCorrelationClaims(body, rawResourceAttrs, resourceAttrs, rawAttrs, attrs, rec),
        ));
      }
    }
  }

  const firstAttrs = events[0]?.attributes;
  return {
    ...body,
    sourceType: body.sourceType ?? 'otel',
    sourceName: body.sourceName ?? (firstAttrs ? attrText(firstAttrs, 'service.name') : undefined),
    collectorId: body.collectorId ?? (firstAttrs ? attrText(firstAttrs, 'anysentry.collector.id', 'collector.id', 'host.name') : undefined),
    workspacePath: body.workspacePath ?? events[0]?.workspacePath,
    events,
  };
}

function otlpMetricValue(
  metricName: string,
  metric: Record<string, unknown>,
  point: Record<string, unknown>,
): { name: string; value: number; kind: 'gauge' | 'counter' | 'histogram_summary' } | undefined {
  const direct = finiteNumber(point.asDouble) ?? finiteNumber(point.asInt) ?? finiteNumber(point.value);
  if (direct !== undefined) {
    return {
      name: metricName,
      value: direct,
      kind: obj(metric.sum) ? 'counter' : 'gauge',
    };
  }
  const count = finiteNumber(point.count);
  const sum = finiteNumber(point.sum);
  const bounds = Array.isArray(point.explicitBounds)
    ? point.explicitBounds.map(Number).filter(Number.isFinite)
    : [];
  const buckets = Array.isArray(point.bucketCounts)
    ? point.bucketCounts.map(Number).filter((value) => Number.isFinite(value) && value >= 0)
    : [];
  if (count && count > 0 && bounds.length > 0 && buckets.length > 0) {
    const threshold = count * 0.95;
    let cumulative = 0;
    let p95 = bounds.at(-1) as number;
    for (let index = 0; index < buckets.length; index += 1) {
      cumulative += buckets[index];
      if (cumulative >= threshold) {
        p95 = bounds[Math.min(index, bounds.length - 1)] ?? p95;
        break;
      }
    }
    return { name: `${metricName}.p95`, value: p95, kind: 'histogram_summary' };
  }
  if (count && count > 0 && sum !== undefined) {
    return { name: `${metricName}.mean`, value: sum / count, kind: 'histogram_summary' };
  }
  const quantiles = Array.isArray(point.quantileValues) ? point.quantileValues : [];
  const p95 = quantiles
    .map((value) => obj(value))
    .find((value) => Math.abs((finiteNumber(value?.quantile) ?? 0) - 0.95) < 0.000_1);
  const p95Value = finiteNumber(p95?.value);
  return p95Value === undefined
    ? undefined
    : { name: `${metricName}.p95`, value: p95Value, kind: 'histogram_summary' };
}

function otlpMetricsToUniversal(
  body: T.UniversalIngestRequest & Record<string, unknown>,
): T.UniversalIngestRequest {
  const events: T.UniversalIngestEvent[] = [];
  const resourceMetrics = Array.isArray(body.resourceMetrics) ? body.resourceMetrics.slice(0, 256) : [];
  for (const [resourceIndex, resourceMetric] of resourceMetrics.entries()) {
    const resourceRecord = obj(resourceMetric) ?? {};
    const resourceAttrs = otlpAttributes(obj(resourceRecord.resource)?.attributes);
    const serviceName = attrText(resourceAttrs, 'service.name', 'peer.service');
    if (!serviceName) continue;
    const namespace = attrText(resourceAttrs, 'service.namespace', 'k8s.namespace.name') ?? 'default';
    const environment = attrText(resourceAttrs, 'deployment.environment.name', 'environment.name') ?? 'default';
    const tenant = attrText(resourceAttrs, 'tenant.id', 'anysentry.tenant.id') ?? 'default';
    const workspacePath = body.workspacePath ?? attrText(resourceAttrs, 'anysentry.workspace');
    const resourceDigest = createHash('sha256')
      .update(JSON.stringify([tenant, environment, workspacePath ?? '', namespace, serviceName]))
      .digest('hex')
      .slice(0, 20);
    const resourceId = attrText(resourceAttrs, 'anysentry.service.asset.id') ??
      `service:otel:${serviceName}:${resourceDigest}`;
    const explicitRole = attrText(resourceAttrs, 'anysentry.workload.role');
    const dbSystem = attrText(resourceAttrs, 'db.system.name', 'db.system');
    const messagingSystem = attrText(resourceAttrs, 'messaging.system');
    const resourceKind = attrText(resourceAttrs, 'anysentry.service.kind') ??
      (dbSystem ? 'database' : messagingSystem ? 'queue' : 'service');
    const physicalWorkloadId = attrText(
      resourceAttrs,
      'anysentry.physical_workload.id',
      'k8s.pod.uid',
      'container.id',
      'service.instance.id',
    );
    const defaults = otlpDefaults(resourceAttrs, body);
    const scopes = (resourceRecord.scopeMetrics ?? resourceRecord.instrumentationLibraryMetrics) as unknown;
    let resourceObservedAt: number | undefined;
    let metricSequence = 0;
    for (const scopeMetric of Array.isArray(scopes) ? scopes.slice(0, 256) : []) {
      const metrics = obj(scopeMetric)?.metrics;
      for (const rawMetric of Array.isArray(metrics) ? metrics.slice(0, 1_000) : []) {
        const metric = obj(rawMetric) ?? {};
        const metricName = cleanString(metric.name, 240);
        if (!metricName) continue;
        const metricUnit = cleanString(metric.unit, 80) ?? '1';
        const data = obj(metric.gauge) ?? obj(metric.sum) ?? obj(metric.histogram) ??
          obj(metric.exponentialHistogram) ?? obj(metric.summary);
        const points = Array.isArray(data?.dataPoints) ? data.dataPoints.slice(0, 10_000) : [];
        for (const rawPoint of points) {
          const point = obj(rawPoint) ?? {};
          const pointAttrs = otlpAttributes(point.attributes);
          const normalized = otlpMetricValue(metricName, metric, point);
          if (!normalized) continue;
          const at = otlpTimeMs(point.timeUnixNano, point.startTimeUnixNano) ?? Date.now();
          resourceObservedAt = Math.max(resourceObservedAt ?? 0, at);
          const statusValue = attrText(pointAttrs, 'anysentry.metric.status');
          const status = statusValue === 'normal' || statusValue === 'anomalous' ? statusValue : 'unknown';
          const id = `otel-metric-${createHash('sha256')
            .update(JSON.stringify([resourceId, normalized.name, at, metricSequence]))
            .digest('hex').slice(0, 24)}`;
          metricSequence += 1;
          events.push({
            id,
            at,
            kind: 'SystemContext',
            eventKind: 'SystemContext',
            eventCategory: 'runtime',
            source: 'api',
            subject: `${serviceName} ${normalized.name}`,
            ...defaults,
            workspacePath,
            agentId: 'system-context-source',
            sessionId: attrText(resourceAttrs, 'service.instance.id') ?? `otel-service:${resourceId}`,
            userId: 'system',
            attributes: {
              ...resourceAttrs,
              ...pointAttrs,
              'context.fact.type': 'metric',
              'context.source.kind': 'otel',
              'context.metric.id': id,
              'context.metric.resource_id': resourceId,
              'context.metric.name': normalized.name,
              'context.metric.value': normalized.value,
              'context.metric.unit': metricUnit,
              'context.metric.kind': normalized.kind,
              'context.metric.status': status,
              'context.metric.observed_at_ms': at,
              'context.freshness.ttl_ms': 5 * 60_000,
              'context.association.confidence': 1,
              'context.association.method': 'otel_resource_identity',
              'context.association.inferred': false,
            },
          });
        }
      }
    }
    if (resourceObservedAt !== undefined) {
      const resourceObservationId = `otel-resource-${createHash('sha256')
        .update(JSON.stringify([resourceId, resourceObservedAt]))
        .digest('hex').slice(0, 24)}`;
      events.unshift({
        id: resourceObservationId,
        at: resourceObservedAt,
        kind: 'SystemContext',
        eventKind: 'SystemContext',
        eventCategory: 'runtime',
        source: 'api',
        subject: `${serviceName} service resource`,
        ...defaults,
        workspacePath,
        agentId: 'system-context-source',
        sessionId: attrText(resourceAttrs, 'service.instance.id') ?? `otel-service:${resourceId}`,
        userId: 'system',
        attributes: {
          ...resourceAttrs,
          'context.fact.type': 'resource',
          'context.source.kind': 'otel',
          'context.resource.id': resourceId,
          'context.resource.kind': resourceKind,
          'context.resource.role': explicitRole ?? 'unknown',
          'context.resource.name': serviceName,
          'context.resource.namespace': namespace,
          'context.resource.environment': environment,
          ...(physicalWorkloadId ? { 'context.resource.physical_workload_id': physicalWorkloadId } : {}),
          'context.resource.valid_from_ms': resourceObservedAt,
          'context.freshness.ttl_ms': 5 * 60_000,
          'context.association.confidence': 1,
          'context.association.method': 'otel_resource_identity',
          'context.association.inferred': false,
        },
      });
    }
  }
  return {
    ...body,
    sourceType: body.sourceType ?? 'otel',
    workspacePath: body.workspacePath ?? events[0]?.workspacePath,
    sourceName: body.sourceName ?? 'OTLP Metrics',
    events,
  };
}

@UseGuards(ManagementAuthGuard)
@Controller('security-center')
export class SecurityMonitoringController implements OnModuleDestroy {
  private readonly canonicalDirectoryCache = new Map<string, CanonicalDirectoryCacheEntry>();
  private readonly canonicalDirectoryInFlight = new Map<
    string,
    Promise<T.AgentConversationDirectoryListV4>
  >();
  private canonicalDirectoryCacheBytes = 0;
  private canonicalDirectoryCacheEvicted = 0;
  private canonicalDirectoryCacheExpired = 0;
  private canonicalDirectoryCacheDropped = 0;
  private readonly canonicalSessionCache = new Map<string, CanonicalSessionCacheEntry>();
  private readonly canonicalSessionInFlight = new Map<string, Promise<CanonicalSessionProjection>>();
  private canonicalSessionCacheBytes = 0;
  private canonicalSessionCacheEvicted = 0;
  private canonicalSessionCacheExpired = 0;
  private canonicalSessionCacheDropped = 0;
  // Secondary projections are scheduled only after the primary event block is durable.  Keep a
  // controller-local gate for interaction/session writes that may still touch PostgreSQL; this is
  // separate from the Judge's business-effect gate because the two lanes have different owners.
  private readonly observerProjectionMaxInFlight = boundedControllerEnvInt(
    'ANYSENTRY_OBSERVER_POST_COMMIT_PROJECTION_MAX_IN_FLIGHT',
    32,
    1,
    256,
  );
  private readonly observerProjectionTimeoutMs = boundedControllerEnvInt(
    'ANYSENTRY_OBSERVER_POST_COMMIT_PROJECTION_TIMEOUT_MS',
    250,
    25,
    10_000,
  );
  private observerProjectionInFlight = 0;
  private observerProjectionScheduled = 0;
  private observerProjectionCompleted = 0;
  private observerProjectionFailed = 0;
  private observerProjectionTimedOut = 0;
  private observerProjectionDropped = 0;
  private observerProjectionClosing = false;

  constructor(
    private readonly agg: AggregationService,
    private readonly agentMetadata: AgentMetadataService,
    private readonly alerting: AlertingService,
    private readonly remediation: RemediationService,
    private readonly audit: AuditService,
    private readonly sources: IngestionSourceService,
    private readonly maintenance: MaintenanceWindowService,
    private readonly notifications: NotificationService,
    private readonly objectives: ObjectiveService,
    private readonly judge: SentryJudgeService,
    private readonly runtimeModels: RuntimeModelConfigService,
    private readonly kube: KubeIdentityService,
    private readonly streaming: StreamingQueueService,
    private readonly streamFindings: StreamingFindingService,
    private readonly supplyChain: SupplyChainService,
    private readonly assistant: SecurityAssistantService,
    private readonly identityReview: IdentityReviewAgentService,
    private readonly agentRuntimeState: AgentRuntimeStateService,
    private readonly relational: RelationalBusinessStore,
    private readonly workspaceDirectory: WorkspaceDirectoryService,
    private readonly systemContext: SystemContextService,
    private readonly unknownLearning: UnknownLearningRuntimeService,
    private readonly infrastructureRules: InfrastructureRuleService,
    private readonly observedAssets: ObservedAssetLifecycleService,
    private readonly users: UserDirectoryService,
    private readonly platformMetrics: PlatformMetricsService,
    private readonly canonicalObservability: CanonicalObservabilityService,
    @Optional() private readonly conversationBindings?: AgentConversationBindingService,
  ) {}

  onModuleDestroy(): void {
    this.observerProjectionClosing = true;
    // These process-level replay fences are compatibility caches, not durable facts.  Explicitly
    // clear them on a graceful shutdown so a hot-reload/test process cannot retain source payload
    // digests or result envelopes beyond its lifecycle.
    clearIngressCaches();
    this.canonicalDirectoryCache.clear();
    this.canonicalDirectoryInFlight.clear();
    this.canonicalDirectoryCacheBytes = 0;
    this.canonicalSessionCache.clear();
    this.canonicalSessionInFlight.clear();
    this.canonicalSessionCacheBytes = 0;
  }

  private canonicalDirectoryCacheKey(
    query: CanonicalEntityQuery,
    headers: HeaderBag,
  ): string {
    const actor = auditActor(headers);
    // Directory data is a broad projection. Entity IDs and pagination are applied by each
    // canonical resource after the snapshot is read, so retaining them here would defeat
    // coalescing when a page opens its LogicalAgent, AgentInstance, RuntimeInstance, and Session
    // details concurrently. Keep all other filters (including source/tenant) in the key; local
    // scope matching still performs the final security check and never treats a missing field as
    // a wildcard.
    const {
      limit: _limit,
      offset: _offset,
      cursor: _cursor,
      revision: _revision,
      includeCoverage: _includeCoverage,
      logicalAgentId: _logicalAgentId,
      logicalAgentCandidateId: _logicalAgentCandidateId,
      agentInstanceId: _agentInstanceId,
      runtimeInstanceId: _runtimeInstanceId,
      sessionId: _sessionId,
      ...projectionQuery
    } = query;
    return JSON.stringify({
      query: projectionQuery,
      actor: {
        type: actor.type,
        id: actor.id,
      },
    });
  }

  private pruneCanonicalDirectoryCache(now = Date.now()): void {
    for (const [key, entry] of this.canonicalDirectoryCache) {
      if (entry.expiresAt > now) continue;
      this.canonicalDirectoryCache.delete(key);
      this.canonicalDirectoryCacheBytes = Math.max(0, this.canonicalDirectoryCacheBytes - entry.bytes);
      this.canonicalDirectoryCacheExpired += 1;
    }
  }

  private rememberCanonicalDirectorySnapshot(
    key: string,
    value: T.AgentConversationDirectoryListV4,
  ): void {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
      this.canonicalDirectoryCacheDropped += 1;
      return;
    }
    if (bytes > CANONICAL_DIRECTORY_CACHE_MAX_BYTES) {
      this.canonicalDirectoryCacheDropped += 1;
      return;
    }
    const previous = this.canonicalDirectoryCache.get(key);
    if (previous) {
      this.canonicalDirectoryCache.delete(key);
      this.canonicalDirectoryCacheBytes = Math.max(0, this.canonicalDirectoryCacheBytes - previous.bytes);
    }
    this.canonicalDirectoryCache.set(key, {
      value,
      bytes,
      expiresAt: Date.now() + CANONICAL_DIRECTORY_CACHE_TTL_MS,
    });
    this.canonicalDirectoryCacheBytes += bytes;
    this.pruneCanonicalDirectoryCache();
    while (
      this.canonicalDirectoryCache.size > CANONICAL_DIRECTORY_CACHE_MAX_ENTRIES
      || this.canonicalDirectoryCacheBytes > CANONICAL_DIRECTORY_CACHE_MAX_BYTES
    ) {
      const oldest = this.canonicalDirectoryCache.entries().next().value as
        | [string, CanonicalDirectoryCacheEntry]
        | undefined;
      if (!oldest) break;
      this.canonicalDirectoryCache.delete(oldest[0]);
      this.canonicalDirectoryCacheBytes = Math.max(0, this.canonicalDirectoryCacheBytes - oldest[1].bytes);
      this.canonicalDirectoryCacheEvicted += 1;
    }
  }

  private canonicalDirectoryCacheStats(): Record<string, number> {
    this.pruneCanonicalDirectoryCache();
    return {
      entries: this.canonicalDirectoryCache.size,
      bytes: this.canonicalDirectoryCacheBytes,
      maxEntries: CANONICAL_DIRECTORY_CACHE_MAX_ENTRIES,
      maxBytes: CANONICAL_DIRECTORY_CACHE_MAX_BYTES,
      ttlMs: CANONICAL_DIRECTORY_CACHE_TTL_MS,
      inFlight: this.canonicalDirectoryInFlight.size,
      maxInFlight: CANONICAL_DIRECTORY_INFLIGHT_MAX,
      evicted: this.canonicalDirectoryCacheEvicted,
      expired: this.canonicalDirectoryCacheExpired,
      dropped: this.canonicalDirectoryCacheDropped,
    };
  }

  private canonicalSessionCacheKey(
    query: CanonicalEntityQuery,
    headers: HeaderBag,
  ): string {
    const actor = auditActor(headers);
    // Session detail/timeline/coverage calls for the same entity use the same bounded conversation
    // projection. Pagination and requested revision are response concerns, but retain every
    // identity/filter field here: computeCanonicalSessionResources applies those predicates while
    // assembling the resource list, so dropping one would let a cached session leak into a sibling
    // request or make it appear missing.
    const {
      limit: _limit,
      offset: _offset,
      cursor: _cursor,
      revision: _revision,
      includeCoverage: _includeCoverage,
      ...projectionQuery
    } = query;
    return JSON.stringify({
      query: projectionQuery,
      actor: {
        type: actor.type,
        id: actor.id,
      },
    });
  }

  private pruneCanonicalSessionCache(now = Date.now()): void {
    for (const [key, entry] of this.canonicalSessionCache) {
      if (entry.expiresAt > now) continue;
      this.canonicalSessionCache.delete(key);
      this.canonicalSessionCacheBytes = Math.max(0, this.canonicalSessionCacheBytes - entry.bytes);
      this.canonicalSessionCacheExpired += 1;
    }
  }

  private rememberCanonicalSessionProjection(
    key: string,
    value: CanonicalSessionProjection,
  ): void {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
      this.canonicalSessionCacheDropped += 1;
      return;
    }
    if (bytes > CANONICAL_SESSION_CACHE_MAX_BYTES) {
      this.canonicalSessionCacheDropped += 1;
      return;
    }
    const previous = this.canonicalSessionCache.get(key);
    if (previous) {
      this.canonicalSessionCache.delete(key);
      this.canonicalSessionCacheBytes = Math.max(0, this.canonicalSessionCacheBytes - previous.bytes);
    }
    this.canonicalSessionCache.set(key, {
      value,
      bytes,
      expiresAt: Date.now() + CANONICAL_SESSION_CACHE_TTL_MS,
    });
    this.canonicalSessionCacheBytes += bytes;
    this.pruneCanonicalSessionCache();
    while (
      this.canonicalSessionCache.size > CANONICAL_SESSION_CACHE_MAX_ENTRIES
      || this.canonicalSessionCacheBytes > CANONICAL_SESSION_CACHE_MAX_BYTES
    ) {
      const oldest = this.canonicalSessionCache.entries().next().value as
        | [string, CanonicalSessionCacheEntry]
        | undefined;
      if (!oldest) break;
      this.canonicalSessionCache.delete(oldest[0]);
      this.canonicalSessionCacheBytes = Math.max(0, this.canonicalSessionCacheBytes - oldest[1].bytes);
      this.canonicalSessionCacheEvicted += 1;
    }
  }

  private canonicalSessionCacheStats(): Record<string, number> {
    this.pruneCanonicalSessionCache();
    return {
      entries: this.canonicalSessionCache.size,
      bytes: this.canonicalSessionCacheBytes,
      maxEntries: CANONICAL_SESSION_CACHE_MAX_ENTRIES,
      maxBytes: CANONICAL_SESSION_CACHE_MAX_BYTES,
      ttlMs: CANONICAL_SESSION_CACHE_TTL_MS,
      inFlight: this.canonicalSessionInFlight.size,
      maxInFlight: CANONICAL_SESSION_INFLIGHT_MAX,
      evicted: this.canonicalSessionCacheEvicted,
      expired: this.canonicalSessionCacheExpired,
      dropped: this.canonicalSessionCacheDropped,
    };
  }

  private bindObservedAssetMeta(meta: T.EventMeta, eventAt?: number): T.EventMeta {
    const trustedCorrelation = serverTrustedCorrelationContext(meta);
    const bound = this.observedAssets?.bindIngestMeta
      ? this.observedAssets.bindIngestMeta(meta, eventAt)
      : meta;
    // Observed Asset binding is intentionally a public EventMeta projection and commonly clones
    // the object. Preserve the server-only WeakMap capability across that trusted server transform;
    // otherwise authenticated Agent adapter invocation/tool claims silently become unassigned.
    return trustedCorrelation && bound !== meta
      ? bindServerTrustedCorrelationContext(bound, trustedCorrelation)
      : bound;
  }

  private materializeCommittedObservedAsset(meta: T.EventMeta, eventAt?: number): void {
    this.observedAssets?.materializeCommittedIngest?.(meta, eventAt);
  }

  /**
   * Commit immutable Observer provenance before the Judge/Projection path.  This is deliberately a
   * best-effort side lane: a raw-store or PostgreSQL outage records a CoverageGap but never drops
   * the compatibility JudgedEvent or blocks the observed workload.
   */
  private async commitCanonicalObservation(
    line: string,
    meta: T.EventMeta,
    sourceResolution: IngestionSourceResolution,
    context: {
      sourceId?: string;
      collectorId?: string;
      sourceType?: T.IngestionSourceType;
      sourceEventId?: string;
    } = {},
  ): Promise<T.EventMeta> {
    // Producer-supplied logical/terminal fields are hints until an authenticated Source or
    // server-side registration validates them.  Legacy/tokenless traffic must remain a candidate
    // and cannot mint a stable LogicalAgent from a forged line.
    const sourceWorkspaceMatches = !sourceResolution.source?.workspacePath
      || sourceResolution.source.workspacePath === meta.workspacePath;
    const rejectedScope = Boolean(serverTrustedCorrelationContext(meta)?.sourceTrust?.rejectionReason);
    const registeredDefinition = sourceResolution.authenticated && sourceWorkspaceMatches && !rejectedScope
      ? this.agentMetadata.resolveRegisteredDefinition(
          meta.workspacePath,
          meta.agentId,
          meta.subjectAssetId
            ?? (typeof meta.attributes?.agentAssetId === 'string' ? meta.attributes.agentAssetId : undefined),
          {
            sourceId: context.sourceId ?? sourceResolution.source?.sourceId,
            logicalAgentId: meta.logicalAgentId,
            logicalDefinitionId: meta.logicalDefinitionId,
            tenantId: meta.tenantId,
            ownerId: meta.ownerId,
            profile: meta.profile,
            terminalContextId: meta.terminalContextId,
            deploymentId: meta.deploymentId,
            deploymentRevision: meta.deploymentRevision,
            environmentId: meta.environmentId,
          },
        )
      : undefined;
    const registeredMeta = registeredDefinition
      ? {
          ...meta,
          // Management-plane registration is the authoritative definition boundary; producer
          // hints cannot silently move an observation to another LogicalAgent.
          logicalAgentId: registeredDefinition.logicalAgentId,
          logicalDefinitionId: registeredDefinition.definitionId,
          logicalScopeMode: registeredDefinition.logicalScopeMode,
          logicalIdentityAuthority: 'management_registration' as const,
          logicalDefinitionFingerprint: registeredDefinition.definitionFingerprint,
          // Registration owns the definition-scoped tuple. Do not let stale producer values alter
          // the Session namespace or AgentInstance key after the logical ID has been authenticated.
          tenantId: registeredDefinition.tenantId,
          ownerId: registeredDefinition.ownerId,
          profile: registeredDefinition.profile,
          profileVersion: registeredDefinition.profileVersion,
          deploymentId: registeredDefinition.deploymentId ?? meta.deploymentId,
          deploymentRevision: registeredDefinition.deploymentRevision ?? meta.deploymentRevision,
          // Environment is part of an AgentInstance/deployment fence.  When the management
          // registration declares it, it wins over a stale producer hint just like the other
          // definition-scoped fields; otherwise retain the transport-normalized environment.
          environmentId: registeredDefinition.environmentId ?? meta.environmentId,
          terminalContextId: registeredDefinition.terminalContextId ?? meta.terminalContextId,
          attributes: {
            ...(meta.attributes ?? {}),
            ...(registeredDefinition.tenantId ? { tenantId: registeredDefinition.tenantId } : {}),
            ...(registeredDefinition.ownerId ? { ownerId: registeredDefinition.ownerId } : {}),
            ...(registeredDefinition.profile ? { profile: registeredDefinition.profile } : {}),
            ...(registeredDefinition.profileVersion ? { profileVersion: registeredDefinition.profileVersion } : {}),
            ...(registeredDefinition.deploymentId ? { deploymentId: registeredDefinition.deploymentId } : {}),
            ...(registeredDefinition.deploymentRevision ? { deploymentRevision: registeredDefinition.deploymentRevision } : {}),
            ...((registeredDefinition.environmentId ?? meta.environmentId)
              ? { environmentId: registeredDefinition.environmentId ?? meta.environmentId } : {}),
            'anysentry.logical_definition_fingerprint': registeredDefinition.definitionFingerprint,
            ...(registeredDefinition.logicalAgentId
              ? { 'anysentry.logical_agent_id': registeredDefinition.logicalAgentId } : {}),
            ...(registeredDefinition.definitionId
              ? { 'anysentry.logical_definition_id': registeredDefinition.definitionId } : {}),
            'anysentry.logical_scope_mode': registeredDefinition.logicalScopeMode,
          },
        }
      : meta;
    // A Source token authenticates the transport, not the business identity.  Only a management
    // registration (or a future explicit Adapter authority) may promote producer hints to a
    // stable LogicalAgent.  This applies to authenticated-but-unregistered Sources as well as
    // tokenless traffic; otherwise any holder of a collector token could mint a confirmed
    // definition by putting logicalAgentId/tenant/profile in an NDJSON line.
    const trustedMeta = registeredDefinition
      ? registeredMeta
      : {
          ...meta,
          logicalAgentId: undefined,
          logicalAgentCandidateId: undefined,
          logicalDefinitionId: undefined,
          logicalScopeMode: 'unresolved' as const,
          logicalIdentityAuthority: 'inferred' as const,
          terminalContextId: undefined,
          // Keep ordinary event attributes for compatibility, but do not let a producer smuggle
          // a tenant/profile/definition tuple into the identity resolver and mint a stable
          // LogicalAgent. Such lines remain candidate/unresolved until registration.
          attributes: Object.fromEntries(Object.entries(meta.attributes ?? {})
            .filter(([key]) => !/^(?:anysentry\.(?:logical|terminal)|logical[_-]|(?:workflow|service|definition|repository)[_.-](?:id|definition(?:[_-]?id)?|scope(?:[_-]?mode)?|revision)|(?:tenant|owner)[_.-]?id|(?:config|agent)[_.-]?profile(?:version)?|profile(?:version)?$)/iu.test(key))),
        };
    // `trustedMeta` is a public compatibility clone. Preserve the server-only capability created
    // by `bindTrustedCorrelationForIngest` across this clone so the subsequent raw commit and
    // Session/semantic resolvers can still distinguish an authenticated Adapter from a payload
    // hint. The capability itself is never serialized or returned to the producer.
    const preCommitTrustedContext = serverTrustedCorrelationContext(meta);
    if (preCommitTrustedContext) bindServerTrustedCorrelationContext(trustedMeta, preCommitTrustedContext);
    const process = trustedMeta.process;
    const processGenerationKey = process?.processGenerationKey
      ?? (process
        ? deriveProcessGenerationKey({
            hostId: process.hostId,
            bootId: process.bootId,
            pid: process.pid ?? 0,
            startTimeNs: process.startTimeNs,
            startTimeTicks: process.startTimeTicks,
          })
        : undefined);
    const observedKind = observerLineEventKind(line) ?? trustedMeta.eventKind;
    const trustedCollector = isTrustedCollectorProducer(
      sourceResolution,
      context.collectorId ?? sourceResolution.source?.collectorId,
    );
    const canonicalInstance = deriveAgentInstanceIdentity({
      logicalAgentId: trustedMeta.logicalAgentId,
      logicalDefinitionId: trustedMeta.logicalDefinitionId,
      logicalScopeMode: trustedMeta.logicalScopeMode,
      deploymentId: trustedMeta.deploymentId,
      deploymentRevision: trustedMeta.deploymentRevision,
      environmentId: trustedMeta.environmentId,
      profile: trustedMeta.profile,
      profileVersion: trustedMeta.profileVersion,
      processGenerationKey,
    });
    const runtimeInstanceId = (trustedCollector || Boolean(registeredDefinition))
      && (trustedMeta.process || trustedMeta.attribution?.agentInstanceId)
      ? agentRuntimeInstanceIdForEvent({
          agentId: trustedMeta.agentId,
          workspacePath: trustedMeta.workspacePath,
          sessionId: trustedMeta.sessionId,
          attributes: trustedMeta.attributes ?? {},
          process: trustedMeta.process,
          attribution: trustedMeta.attribution,
        })
      : undefined;
    const sourceType: import('./canonical-observability').RawObservationSourceType =
      context.sourceType === 'observer' && !trustedCollector
        ? 'api'
        : context.sourceType === 'forwarder' && !trustedCollector
          ? 'api'
          : context.sourceType === 'observer'
        ? ['LlmInteraction', 'AgentPlaintextEvidence', 'SslContent', 'LlmApi'].includes(observedKind ?? '')
          ? 'socket_payload'
          : 'kernel'
        : context.sourceType === 'forwarder' ? 'forwarder'
          : context.sourceType === 'otel' ? 'otel'
            : context.sourceType === 'webhook' ? 'api'
              : 'api';
    const trustedProcess = trustedCollector
      && ['kernel', 'uprobe', 'socket_payload', 'forwarder'].includes(sourceType);
    const committed = await this.canonicalObservability.commitObserverLine(line, {
      sourceId: context.sourceId ?? sourceResolution.source?.sourceId,
      collectorId: context.collectorId ?? sourceResolution.source?.collectorId,
      sourceType,
      sourceSequence: context.sourceEventId,
      eventKind: observerLineEventKind(line) ?? trustedMeta.eventKind,
      eventAtUnixNs: trustedMeta.eventAtUnixNs,
      receivedAtUnixNs: trustedMeta.receivedAtUnixNs,
      observationId: trustedMeta.rawObservationId,
      revision: trustedMeta.rawObservationRevision,
      processGenerationKey: trustedProcess ? processGenerationKey : undefined,
      pid: trustedProcess ? process?.pid : undefined,
      ppid: trustedProcess ? process?.ppid : undefined,
      hostId: trustedProcess ? process?.hostId : undefined,
      bootId: trustedProcess ? process?.bootId : undefined,
      startTimeTicks: trustedProcess ? process?.startTimeTicks : undefined,
      startTimeNs: trustedProcess ? process?.startTimeNs : undefined,
      idempotencyKey: context.sourceEventId
        ? `${context.sourceId ?? sourceResolution.source?.sourceId ?? 'observer'}:${context.sourceEventId}:r${trustedMeta.rawObservationRevision ?? 1}`
        : undefined,
    });
    if (!committed.observation) {
      return {
        ...trustedMeta,
        attributes: {
          ...(trustedMeta.attributes ?? {}),
          'anysentry.raw_commit_status': 'coverage_gap',
        },
      };
    }
    const attached = this.canonicalObservability.attachMeta(trustedMeta, committed.observation);
    // `attachMeta` is an additive public projection and therefore returns a fresh object.  Carry
    // the server-only capability across that clone; otherwise the Judge would silently downgrade
    // an already-authorized application/adapter claim after the canonical raw commit.
    const trustedContext = serverTrustedCorrelationContext(trustedMeta);
    if (trustedContext) bindServerTrustedCorrelationContext(attached, trustedContext);
    const commitStatus = committed.durable ? 'durable' : 'hot_only';
    const attachedWithStatus = {
      ...attached,
      ...(canonicalInstance.agentInstanceId
        ? { canonicalAgentInstanceId: canonicalInstance.agentInstanceId }
        : {}),
      ...(runtimeInstanceId ? { runtimeInstanceId } : {}),
      attributes: {
        ...(attached.attributes ?? {}),
        'anysentry.raw_commit_status': commitStatus,
      },
    };
    const finalMeta = committed.kernelFact
      ? {
          ...attachedWithStatus,
          kernelFactId: committed.kernelFact.factId,
          attributes: {
            ...(attachedWithStatus.attributes ?? {}),
            'anysentry.kernel_fact_id': committed.kernelFact.factId,
          },
        }
      : attachedWithStatus;
    // The status/kernel-fact enrichment above creates another public clone. Re-bind the
    // capability to the exact object returned to the caller; otherwise a later resolver would
    // silently treat an authenticated claim as untrusted after the raw commit.
    if (trustedContext) bindServerTrustedCorrelationContext(finalMeta, trustedContext);
    return finalMeta;
  }

  private modelProfile(value: string): RuntimeModelProfile {
    if (value === 'fast_review' || value === 'deep_investigation') return value;
    throw new BadRequestException('unknown model connection profile');
  }

  private requireWorkspaceScanner(
    headers: Record<string, string | string[] | undefined>,
    scannerId: string,
  ): void {
    let expected = process.env.ANYSENTRY_WORKSPACE_SCANNER_TOKEN?.trim();
    const tokenFile = process.env.ANYSENTRY_WORKSPACE_SCANNER_TOKEN_FILE?.trim();
    if (!expected && tokenFile) {
      try {
        expected = readFileSync(tokenFile, 'utf8').trim();
      } catch {
        throw new UnauthorizedException('workspace scanner token file is unavailable');
      }
    }
    const configuredTokens = process.env.ANYSENTRY_WORKSPACE_SCANNER_TOKENS?.trim();
    if (configuredTokens) {
      try {
        const tokens = JSON.parse(configuredTokens) as Record<string, unknown>;
        expected = typeof tokens[scannerId] === 'string' ? tokens[scannerId].trim() : undefined;
      } catch {
        throw new UnauthorizedException('workspace scanner token configuration is invalid');
      }
    }
    const value = headers['x-anysentry-scanner-token'];
    const presented = (Array.isArray(value) ? value[0] : value)?.trim();
    if (!expected || !presented) throw new UnauthorizedException('workspace scanner token required');
    const expectedHash = createHash('sha256').update(expected).digest();
    const presentedHash = createHash('sha256').update(presented).digest();
    if (!timingSafeEqual(expectedHash, presentedHash)) {
      throw new UnauthorizedException('workspace scanner token required');
    }
  }

  private supplyChainBadRequest(error: unknown): never {
    throw new BadRequestException(error instanceof Error ? error.message : String(error));
  }

  @Post('supply-chain/workspaces/register')
  @HttpCode(200)
  async registerSupplyChainWorkspace(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: RegisterWorkspaceRequest,
  ) {
    this.requireWorkspaceScanner(headers, body.scannerId);
    try {
      return await this.supplyChain.registerWorkspace(body);
    } catch (error) {
      this.supplyChainBadRequest(error);
    }
  }

  @Post('supply-chain/tasks/claim')
  @HttpCode(200)
  async claimSupplyChainScanTask(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: ClaimScanTaskRequest,
  ) {
    this.requireWorkspaceScanner(headers, body.scannerId);
    try {
      return { task: await this.supplyChain.claimTask(body.scannerId) ?? null };
    } catch (error) {
      this.supplyChainBadRequest(error);
    }
  }

  @Put('supply-chain/tasks/:taskId/heartbeat')
  @HttpCode(200)
  async heartbeatSupplyChainScanTask(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param('taskId') taskId: string,
    @Body() body: ScanTaskHeartbeatRequest,
  ) {
    this.requireWorkspaceScanner(headers, body.scannerId);
    try {
      return { task: await this.supplyChain.heartbeat(taskId, body.scannerId, body.leaseToken) };
    } catch (error) {
      this.supplyChainBadRequest(error);
    }
  }

  @Post('supply-chain/tasks/:taskId/result')
  @HttpCode(200)
  async submitSupplyChainScanResult(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param('taskId') taskId: string,
    @Body() body: SubmitScanResultRequest,
  ) {
    this.requireWorkspaceScanner(headers, body.scannerId);
    try {
      return await this.supplyChain.submitResult(taskId, body);
    } catch (error) {
      this.supplyChainBadRequest(error);
    }
  }

  @Post('supply-chain/workspaces/:workspaceId/scan')
  @RequireManagementAuth()
  @HttpCode(202)
  async requestSupplyChainScan(
    @Param('workspaceId') workspaceId: string,
    @Body() body: { reason?: 'manual' | 'dependency_descriptor_changed' | 'retry' },
  ) {
    try {
      return {
        task: await this.supplyChain.enqueueScan(workspaceId, body.reason ?? 'manual'),
      };
    } catch (error) {
      this.supplyChainBadRequest(error);
    }
  }

  @Post('supply-chain/workspaces/:workspaceId/dependency-change')
  @HttpCode(202)
  async notifySupplyChainDependencyChange(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param('workspaceId') workspaceId: string,
    @Body() body: { scannerId: string },
  ) {
    this.requireWorkspaceScanner(headers, body.scannerId);
    try {
      return {
        task: await this.supplyChain.notifyDescriptorChange(workspaceId, body.scannerId),
      };
    } catch (error) {
      this.supplyChainBadRequest(error);
    }
  }

  @Post('supply-chain/workspaces/:workspaceId/assess')
  @RequireManagementAuth()
  @HttpCode(202)
  async requestSupplyChainAssessment(@Param('workspaceId') workspaceId: string) {
    try {
      return await this.supplyChain.requestAssessment(workspaceId);
    } catch (error) {
      this.supplyChainBadRequest(error);
    }
  }

  @Get('supply-chain/config')
  async supplyChainConfig() {
    return this.supplyChain.controlConfig();
  }

  @Put('supply-chain/config')
  @RequireManagementAuth()
  async updateSupplyChainConfig(
    @Body() body: {
      enabled?: boolean;
      dailyRefreshEnabled?: boolean;
      runtimeCorrelationEnabled?: boolean;
      selectedWorkspaceIds?: string[];
      runInitialScan?: boolean;
    },
    @Headers() headers: HeaderBag,
  ) {
    try {
      const result = await this.supplyChain.setControl(body);
      this.audit.record({
        actor: auditActor(headers),
        action: 'supply-chain.config.updated',
        resourceType: 'supply-chain',
        resourceId: 'default',
        summary: body.runInitialScan
          ? 'Supply-chain scanning enabled and initial scans queued'
          : 'Supply-chain configuration updated',
        details: {
          enabled: result.config.enabled,
          dailyRefreshEnabled: result.config.dailyRefreshEnabled,
          runtimeCorrelationEnabled: result.config.runtimeCorrelationEnabled,
          selectedWorkspaceIds: result.config.selectedWorkspaceIds,
          queuedScanTasks: result.scanTasks?.map((task) => task.taskId) ?? [],
          runtimeAssessmentsQueued: result.runtimeAssessmentsQueued ?? 0,
        },
      });
      return result;
    } catch (error) {
      this.supplyChainBadRequest(error);
    }
  }

  @Get('supply-chain/overview')
  async supplyChainOverview(@Query('limit') limit?: string) {
    return this.supplyChain.overview(limit ? Number(limit) : undefined);
  }

  private recordRejectedIngest(resolution: IngestionSourceResolution, reason: string, context: RejectedIngestContext = {}): void {
    this.sources.recordRejected(resolution, reason);
    this.alerting.observeSourceRejection({
      reason,
      source: resolution.source,
      sourceId: context.sourceId ?? resolution.source?.sourceId,
      sourceName: context.sourceName,
      sourceType: context.sourceType ?? resolution.source?.type,
      collectorId: context.collectorId ?? resolution.source?.collectorId,
      workspacePath: context.workspacePath ?? resolution.source?.workspacePath,
      nodeName: context.nodeName,
      endpoint: context.endpoint,
      rejectedEvents: context.rejectedEvents,
    });
  }

  /**
   * Record a bounded, metadata-only gap for work that runs after the immutable event durability
   * fence.  This helper is intentionally non-throwing: coverage reporting cannot be allowed to
   * turn a successfully committed Raw/Kernel fact back into a retryable ingest response.
   */
  private recordObserverProjectionFailure(
    eventId: string,
    projection: string,
    error: unknown,
  ): string | undefined {
    try {
      return this.canonicalObservability.recordGap(
        'projection',
        observerProjectionFailureReason(error),
        eventId,
        {
          projection: projection.slice(0, 120),
          errorCode: observerProjectionFailureCode(error),
        },
      ).gapId;
    } catch {
      // The canonical gap store is a best-effort side lane.  The caller has already crossed the
      // durable fact fence, so a gap-store failure must not make the event retryable.
      return undefined;
    }
  }

  /**
   * Run one post-durability projection behind a bounded, non-blocking gate.  The caller supplies
   * callbacks for result/failure so this helper stays agnostic of ClickHouse, PostgreSQL, Redis,
   * or the particular read model.  A timeout reports a gap immediately but holds the slot until
   * the underlying Promise settles; this keeps a fleet of stuck database calls from exceeding the
   * configured concurrency bound, while the late rejection is still consumed.
   */
  private scheduleObserverProjection<T>(
    eventId: string,
    projection: string,
    operation: () => Promise<T>,
    onResult: (value: T) => void,
    onFailure: (error: unknown) => void,
  ): boolean {
    const report = (error: unknown) => {
      this.observerProjectionFailed += 1;
      try {
        onFailure(error);
      } catch {
        // If a caller's diagnostic callback itself fails, retain a direct canonical gap using the
        // stable event/projection scope supplied to this gate.
        this.recordObserverProjectionFailure(eventId, projection, error);
      }
    };
    if (
      this.observerProjectionClosing
      || this.observerProjectionInFlight >= this.observerProjectionMaxInFlight
    ) {
      this.observerProjectionDropped += 1;
      report(Object.assign(new Error('observer projection gate is at capacity'), {
        code: 'ANYSENTRY_OBSERVER_PROJECTION_CAPACITY',
      }));
      return false;
    }
    this.observerProjectionInFlight += 1;
    this.observerProjectionScheduled += 1;
    let settled = false;
    let reported = false;
    let timeout: NodeJS.Timeout | undefined;
    const release = () => {
      if (timeout) clearTimeout(timeout);
      this.observerProjectionInFlight = Math.max(0, this.observerProjectionInFlight - 1);
    };
    const reportOnce = (error: unknown) => {
      if (reported) return;
      reported = true;
      report(error);
    };
    let task: Promise<T>;
    try {
      task = operation();
    } catch (error) {
      settled = true;
      reportOnce(error);
      release();
      return true;
    }
    timeout = setTimeout(() => {
      if (settled) return;
      this.observerProjectionTimedOut += 1;
      reportOnce(Object.assign(new Error('observer projection timed out'), {
        code: 'ANYSENTRY_OBSERVER_PROJECTION_TIMEOUT',
      }));
    }, this.observerProjectionTimeoutMs);
    timeout.unref();
    void task
      .then((value) => {
        try { onResult(value); } catch (error) { reportOnce(error); }
        if (settled) return;
        settled = true;
        this.observerProjectionCompleted += 1;
        release();
      })
      .catch((error: unknown) => {
        if (!settled) {
          settled = true;
          reportOnce(error);
          release();
        } else {
          // A timeout already reported the failure; consume the late rejection and release slot.
          release();
        }
      });
    return true;
  }

  private observerProjectionStats(): Record<string, number> {
    return {
      inFlight: this.observerProjectionInFlight,
      maxInFlight: this.observerProjectionMaxInFlight,
      timeoutMs: this.observerProjectionTimeoutMs,
      scheduled: this.observerProjectionScheduled,
      completed: this.observerProjectionCompleted,
      failed: this.observerProjectionFailed,
      timedOut: this.observerProjectionTimedOut,
      dropped: this.observerProjectionDropped,
    };
  }

  private async enqueueCanonicalShadow(event: T.JudgedEvent, observerLine: string): Promise<void> {
    try {
      await this.streaming.enqueueCanonical(event, observerLine);
    } catch (error) {
      // Streaming is an optional shadow path. A Redis/Kafka-side outage must never turn an accepted
      // security event into an ingest failure or interfere with the existing L1/L2/L3 pipeline.
      console.error('[streaming] canonical outbox enqueue failed', {
        eventId: event.eventId,
        error: error instanceof Error ? error.message.split('\n')[0].slice(0, 300) : String(error).slice(0, 300),
      });
    }
  }

  /** Batch ingest treats the Redis-backed canonical queue as a required idempotent delivery step. */
  private async enqueueCanonicalBatchMany(events: readonly PreparedObserverBatchEvent[]): Promise<void> {
    await this.streaming.enqueueCanonicalBatch(events.flatMap((item) => (
      item.prepared.disposition === 'retained'
        ? [{ event: item.prepared.event, observerLine: item.line }]
        : []
    )));
  }

  private async observeSupplyChainInstall(event: T.JudgedEvent, observerLine: string): Promise<void> {
    try {
      await this.supplyChain.observeRuntimeInstall(event, observerLine);
    } catch (error) {
      // Runtime install tracking is an optional supply-chain side path. It must not reject an
      // otherwise accepted security event or interfere with L1/L2/L3.
      console.error('[supply-chain] runtime install observation failed', {
        eventId: event.eventId,
        error: error instanceof Error ? error.message.split('\n')[0].slice(0, 300) : String(error).slice(0, 300),
      });
    }
  }

  private observeWorkspaceAssociation(event: T.JudgedEvent): void {
    try {
      this.workspaceDirectory.observeEvent(event);
    } catch (error) {
      // Directory projection is an optional migration side effect. Immutable event acceptance and
      // security judgment remain authoritative even when the business-state store is unavailable.
      console.error('[workspace-directory] association observation failed', {
        eventId: event.eventId,
        error: error instanceof Error ? error.message.split('\n')[0].slice(0, 300) : String(error).slice(0, 300),
      });
    }
  }

  @Post('top/healthCard')
  @HttpCode(200)
  healthCard(@Body() f: T.SecurityTimeFilter) {
    return this.agg.healthCardForWindow(f);
  }

  @Post('top/explainabilityScan')
  @HttpCode(200)
  explainabilityScan(@Body() f: T.ExplainabilityScanRequest) {
    return this.agg.explainabilityScanForWindow(f);
  }

  @Post('top/performanceCard')
  @HttpCode(200)
  performanceCard(@Body() f: T.SecurityTimeFilter) {
    return this.agg.performanceCardForWindow(f);
  }

  @Post('risks/summary')
  @HttpCode(200)
  riskSummary(@Body() f: T.SecurityTimeFilter) {
    return this.agg.riskSummaryForWindow(f);
  }

  @Post('risks/breakdown')
  @HttpCode(200)
  riskBreakdown(@Body() f: T.SecurityTimeFilter) {
    return this.agg.riskBreakdownForWindow(f);
  }

  @Post('sessions/highestRisk')
  @HttpCode(200)
  highestRisk(@Body() f: T.SecurityTimeFilter) {
    return this.agg.highestRiskSessionForWindow(f);
  }

  @Post('sessions/decisionFunnel')
  @HttpCode(200)
  decisionFunnel(@Body() f: T.SecurityTimeFilter) {
    return this.agg.decisionFunnelForWindow(f);
  }

  @Post('sessions/agentObservability')
  @HttpCode(200)
  agentObservability(@Body() f: T.SecurityTimeFilter) {
    return this.agg.sharedAgentObservabilityForWindow(f);
  }

  @Post('sessions/workspaceRiskDistribution')
  @HttpCode(200)
  workspaceRiskDistribution(@Body() f: T.SecurityTimeFilter) {
    return this.agg.workspaceRiskDistributionForWindow(f);
  }

  @Post('events/list')
  @HttpCode(200)
  async agentEvents(@Body() f: T.AgentEventQuery) {
    if (f.preview) return this.observedAssets.annotateEventList(this.agg.agentEventsPreview(f));
    // Durable history is the default. The bounded in-process ring is an explicit low-latency
    // fallback/debug path and must not decide whether an event still exists.
    const result = await (f.durable !== false
      ? this.agg.storedAgentEvents(f)
      : this.agg.agentEventsForWindow(f));
    return this.observedAssets.annotateEventList(result);
  }

  @Post('assistant/query')
  @HttpCode(200)
  assistantQuery(@Body() body: T.SecurityAssistantQuery) {
    if (!body || typeof body.question !== 'string' || !body.question.trim()) {
      throw new BadRequestException('assistant question is required');
    }
    return this.assistant.answer(body);
  }

  @Post('events/timeline')
  @HttpCode(200)
  async agentTimeline(@Body() f: T.AgentEventQuery) {
    const result = await (f.durable !== false
      ? this.agg.storedAgentTimeline(f)
      : this.agg.agentTimeline(f));
    return this.observedAssets.annotateTimeline(result);
  }

  @Post('agents/actions')
  @HttpCode(200)
  agentActions(@Body() f: T.AgentEventQuery) {
    return this.agg.storedAgentActions(f);
  }

  @Post('agents/interactions')
  @HttpCode(200)
  async agentInteractions(
    @Body() f: T.AgentInteractionQuery,
    @Headers() headers: HeaderBag,
  ) {
    const agentAssetId = f?.agentAssetId === undefined
      ? undefined
      : strictIdentityText(f.agentAssetId, 512);
    const agentInstanceId = f?.agentInstanceId === undefined
      ? undefined
      : strictIdentityText(f.agentInstanceId, 512);
    const interactionId = f?.interactionId === undefined
      ? undefined
      : strictIdentityText(f.interactionId, 160);
    if (f?.agentAssetId !== undefined && !agentAssetId) {
      throw new BadRequestException('agentAssetId is invalid');
    }
    if (f?.agentInstanceId !== undefined && !agentInstanceId) {
      throw new BadRequestException('agentInstanceId is invalid');
    }
    if (f?.interactionId !== undefined && !interactionId) {
      throw new BadRequestException('interactionId is invalid');
    }
    const result = await this.agg.agentInteractions({ ...f, agentAssetId, agentInstanceId, interactionId });
    this.audit.record({
      actor: auditActor(headers),
      action: 'agent.interaction.content.read',
      resourceType: 'agent',
      resourceId: agentAssetId ?? interactionId ?? 'interaction-query',
      summary: `Read ${result.items.length} Agent interaction content record(s)`,
      details: {
        agentAssetId,
        agentInstanceId,
        interactionId,
        resultCount: result.items.length,
        requestedLimit: f?.limit,
        classificationView: f?.classificationView,
        scope: f?.scope,
      },
    });
    return result;
  }

  @Post('agents/conversations')
  @HttpCode(200)
  async agentConversations(
    @Body() f: T.AgentConversationQuery,
    @Headers() headers: HeaderBag,
  ) {
    const agentAssetId = f?.agentAssetId === undefined
      ? undefined
      : strictIdentityText(f.agentAssetId, 512);
    const agentInstanceId = f?.agentInstanceId === undefined
      ? undefined
      : strictIdentityText(f.agentInstanceId, 512);
    const conversationId = f?.conversationId === undefined
      ? undefined
      : strictIdentityText(f.conversationId, 512);
    if (f?.agentAssetId !== undefined && !agentAssetId) {
      throw new BadRequestException('agentAssetId is invalid');
    }
    if (f?.agentInstanceId !== undefined && !agentInstanceId) {
      throw new BadRequestException('agentInstanceId is invalid');
    }
    if (f?.conversationId !== undefined && !conversationId) {
      throw new BadRequestException('conversationId is invalid');
    }
    const result = await this.agg.agentConversations({
      ...f,
      agentAssetId,
      agentInstanceId,
      conversationId,
    });
    this.audit.record({
      actor: auditActor(headers),
      action: 'agent.conversation.content.list',
      resourceType: 'agent',
      resourceId: agentAssetId ?? 'conversation-query',
      summary: `Read ${result.items.length} Agent conversation summary record(s)`,
      details: {
        agentAssetId,
        agentInstanceId,
        resultCount: result.items.length,
        requestedLimit: f?.limit,
        classificationView: f?.classificationView,
        scope: f?.scope,
      },
    });
    return result;
  }

  @Post('agents/conversations/timeline')
  @HttpCode(200)
  async agentConversationTimeline(
    @Body() f: T.AgentConversationQuery,
    @Headers() headers: HeaderBag,
  ) {
    const conversationId = strictIdentityText(f?.conversationId, 512);
    if (!conversationId) {
      throw new BadRequestException('a valid conversationId is required');
    }
    const agentAssetId = f?.agentAssetId === undefined
      ? undefined
      : strictIdentityText(f.agentAssetId, 512);
    if (f?.agentAssetId !== undefined && !agentAssetId) {
      throw new BadRequestException('agentAssetId is invalid');
    }
    const result = await this.agg.agentConversationTimeline({
      ...f,
      conversationId,
      agentAssetId,
    });
    this.audit.record({
      actor: auditActor(headers),
      action: 'agent.conversation.content.read',
      resourceType: 'agent',
      resourceId: agentAssetId ?? conversationId,
      summary: `Read Agent conversation timeline with ${result.items.length} event(s)`,
      details: {
        agentAssetId,
        conversationId,
        resultCount: result.items.length,
        interactionCount: result.interactionIds.length,
        classificationView: f?.classificationView,
      },
    });
    return result;
  }

  @Post('agents/conversations/timeline-v2')
  @HttpCode(200)
  async agentConversationTimelineV2(
    @Body() f: T.AgentConversationQuery,
    @Headers() headers: HeaderBag,
  ) {
    const conversationId = strictIdentityText(f?.conversationId, 512);
    if (!conversationId) {
      throw new BadRequestException('a valid conversationId is required');
    }
    const agentAssetId = f?.agentAssetId === undefined
      ? undefined
      : strictIdentityText(f.agentAssetId, 512);
    if (f?.agentAssetId !== undefined && !agentAssetId) {
      throw new BadRequestException('agentAssetId is invalid');
    }
    const result = await this.agg.agentConversationTimelineV2({
      ...f,
      conversationId,
      agentAssetId,
    });
    this.audit.record({
      actor: auditActor(headers),
      action: 'agent.conversation.content.read',
      resourceType: 'agent',
      resourceId: agentAssetId ?? conversationId,
      summary: `Read Agent semantic conversation timeline with ${result.turns.length} turn(s)`,
      details: {
        agentAssetId,
        conversationId,
        turnCount: result.turns.length,
        interactionCount: result.interactionIds.length,
        parserVersion: result.parserVersion,
        classificationView: f?.classificationView,
      },
    });
    return result;
  }

  @Post('agents/conversations/timeline-v3')
  @HttpCode(200)
  async agentConversationTimelineV3(
    @Body() f: T.AgentConversationQuery,
    @Headers() headers: HeaderBag,
  ): Promise<T.AgentConversationTimelineV3> {
    const conversationId = strictIdentityText(f?.conversationId, 512);
    if (!conversationId) {
      throw new BadRequestException('a valid conversationId is required');
    }
    const agentAssetId = f?.agentAssetId === undefined
      ? undefined
      : strictIdentityText(f.agentAssetId, 512);
    if (f?.agentAssetId !== undefined && !agentAssetId) {
      throw new BadRequestException('agentAssetId is invalid');
    }
    const result = await this.agg.agentConversationTimelineV3({
      ...f,
      conversationId,
      agentAssetId,
    });
    this.audit.record({
      actor: auditActor(headers),
      action: 'agent.conversation.content.read',
      resourceType: 'agent',
      resourceId: result.canonicalConversationId ?? conversationId,
      summary: `Read Agent canonical conversation timeline with ${result.turns.length} turn(s)`,
      details: {
        agentAssetId,
        requestedConversationId: conversationId,
        canonicalConversationId: result.canonicalConversationId,
        resolutionRevision: result.resolutionRevision,
        turnCount: result.turns.length,
        interactionCount: result.interactionIds.length,
        replaySummaryCount: result.contextReplaySummaries.length,
        classificationView: f?.classificationView,
      },
    });
    return result;
  }

  @Post('agents/semantic-events/evidence')
  @HttpCode(200)
  async agentSemanticEvidence(
    @Body() f: T.AgentSemanticEvidenceQuery,
    @Headers() headers: HeaderBag,
  ): Promise<T.AgentSemanticEvidenceResponse> {
    const conversationId = strictIdentityText(f?.conversationId, 512);
    const semanticEventId = strictIdentityText(f?.semanticEventId, 512);
    if (!conversationId || !semanticEventId) {
      throw new BadRequestException('valid conversationId and semanticEventId are required');
    }
    const result = await this.agg.agentSemanticEvidence({
      ...f,
      conversationId,
      semanticEventId,
    });
    if (!result) throw new NotFoundException('semantic tool event was not found');
    const canonicalLinks = canonicalEvidenceLinksForRelations(result.relations);
    const canonicalRelations = result.relations.map((relation, index) => {
      const link = canonicalLinks[index];
      return link
        ? {
            ...relation,
            evidenceLinkId: link.linkId,
            algorithmVersion: link.algorithmVersion,
            sourceRefs: link.evidenceRefs,
            validFromUnixNs: link.validFromUnixNs,
            relationRevision: link.resolutionRevision,
          }
        : relation;
    });
    const response = { ...result, relations: canonicalRelations };
    // Read paths are side-effect free. EvidenceLinks are materialized by the ingest-triggered
    // correlation projector; this endpoint only returns the latest computed relation (or its
    // durable revision) and never creates a new revision because an inspector was opened.
    this.audit.record({
      actor: auditActor(headers),
      action: 'agent.semantic_evidence.read',
      resourceType: 'event',
      resourceId: semanticEventId,
      summary: `Read semantic tool evidence with ${result.relations.length} relation(s)`,
      details: {
        conversationId: result.conversationId,
        semanticEventId,
        toolInvocationId: result.toolInvocationId,
        relationStatus: response.relationStatus,
        kernelEventCount: response.kernelEvents.length,
      },
    });
    return response;
  }

  @Post('agents/kernel-events/semantic-context')
  @HttpCode(200)
  async agentKernelSemanticContext(
    @Body() body: { eventId?: string },
    @Headers() headers: HeaderBag,
  ): Promise<T.AgentKernelSemanticContextResponse> {
    const eventId = strictIdentityText(body?.eventId, 512);
    if (!eventId) throw new BadRequestException('a valid eventId is required');
    const result = await this.agg.agentKernelSemanticContext(eventId);
    const canonicalLinks = canonicalEvidenceLinksForRelations(result.relations);
    const response = {
      ...result,
      relations: result.relations.map((relation, index) => {
        const link = canonicalLinks[index];
        return link
          ? {
              ...relation,
              evidenceLinkId: link.linkId,
              algorithmVersion: link.algorithmVersion,
              sourceRefs: link.evidenceRefs,
              validFromUnixNs: link.validFromUnixNs,
              relationRevision: link.resolutionRevision,
            }
          : relation;
      }),
    };
    // Evidence relation persistence belongs to the ingest/correlation projector. Keep this query
    // endpoint read-only so repeated inspector refreshes cannot mutate relation history.
    this.audit.record({
      actor: auditActor(headers),
      action: 'agent.semantic_evidence.read',
      resourceType: 'event',
      resourceId: eventId,
      summary: `Read Kernel event semantic context with ${result.relations.length} relation(s)`,
      details: {
        eventId,
        relationCount: response.relations.length,
        conversationCount: response.conversationLinks.length,
      },
    });
    return response;
  }

  @Post('agents/conversation-directory')
  @HttpCode(200)
  async agentConversationDirectory(
    @Body() f: T.AgentConversationDirectoryQuery,
    @Headers() headers: HeaderBag,
  ): Promise<T.AgentConversationDirectoryList> {
    // Preserve the historical default page size, but honor an explicit bounded limit.  Canonical
    // entity GETs request a small page; forcing every request through the legacy 200-thread page
    // expanded multi-megabyte summaries and made the read path spend most of its time cloning and
    // serializing data that the caller did not ask for.
    const requestedLimit = Number(f?.limit);
    const conversationLimit = Number.isFinite(requestedLimit)
      ? Math.min(200, Math.max(1, Math.trunc(requestedLimit)))
      : 200;
    const conversations = await this.agentConversations(
      { ...f, limit: conversationLimit },
      headers,
    );
    const runtime = f?.includeRuntimeOnly === false
      ? { items: [] as T.AgentRuntimeInstanceRecord[] }
      : this.agentRuntimeState.list({ includeShadow: true, limit: 100_000 });
    const items = projectAgentConversationDirectory(
      conversations.items,
      runtime.items,
      f?.lifecycleScope ?? 'all',
    );
    const runningCount = items.filter((item) => item.lifecycleState !== 'historical').length;
    const historicalCount = items.length - runningCount;
    this.audit.record({
      actor: auditActor(headers),
      action: 'agent.conversation.content.list',
      resourceType: 'agent',
      resourceId: 'logical-agent-directory',
      summary: 'Read ' + items.length + ' logical Agent conversation directory record(s)',
      details: {
        runningCount,
        historicalCount,
        lifecycleScope: f?.lifecycleScope ?? 'all',
      },
    });
    return {
      items,
      runningCount,
      historicalCount,
      total: items.length,
      totalMode: conversations.totalMode,
      coverage: conversations.coverage,
      dataSource: conversations.dataSource,
      classificationView: conversations.classificationView,
      reviewRevision: conversations.reviewRevision,
      ...(conversations.assetBindingRevision !== undefined
        ? { assetBindingRevision: conversations.assetBindingRevision }
        : {}),
      updateTime: conversations.updateTime,
    };
  }

  @Post('agents/conversation-directory-v2')
  @HttpCode(200)
  async agentConversationDirectoryV2(
    @Body() f: T.AgentConversationDirectoryQuery,
    @Headers() headers: HeaderBag,
  ): Promise<T.AgentConversationDirectoryListV2> {
    const legacy = await this.agentConversationDirectory(f, headers);
    const runtime = f?.includeRuntimeOnly === false
      ? { items: [] as T.AgentRuntimeInstanceRecord[] }
      : this.agentRuntimeState.list({ includeShadow: true, limit: 100_000 });
    return {
      ...legacy,
      apiVersion: 2,
      items: enrichAgentConversationDirectoryV2(legacy.items, runtime.items),
    };
  }

  @Post('agents/conversation-directory-v3')
  @HttpCode(200)
  async agentConversationDirectoryV3(
    @Body() f: T.AgentConversationDirectoryQuery,
    @Headers() headers: HeaderBag,
  ): Promise<T.AgentConversationDirectoryListV3> {
    const legacy = await this.agentConversationDirectoryV2(f, headers);
    const technical = this.agg.agentRunTechnicalActivities();
    return {
      ...legacy,
      apiVersion: 3,
      resolutionRevision: this.agg.agentConversationResolutionRevision(),
      items: legacy.items.map((item) => {
        const instanceIds = new Set(item.agentInstanceIds);
        const technicalActivities = technical.filter((activity) =>
          activity.agentInstanceId && instanceIds.has(activity.agentInstanceId));
        return {
          ...item,
          // V3 presents only human-visible conversation Threads. Asset-only placeholders remain
          // available through the legacy `conversations` compatibility field but must not pollute
          // the operator's Thread list.
          userThreads: item.conversations.filter((conversation) => conversation.hasContent),
          technicalActivities,
          technicalActivityCount: technicalActivities.reduce(
            (sum, activity) => sum + activity.interactionIds.length,
            0,
          ),
        };
      }),
    };
  }

  @Post('agents/conversation-directory-v4')
  @HttpCode(200)
  async agentConversationDirectoryV4(
    @Body() f: T.AgentConversationDirectoryQuery,
    @Headers() headers: HeaderBag,
  ): Promise<T.AgentConversationDirectoryListV4> {
    const legacy = await this.agentConversationDirectoryV3(f, headers);
    return {
      ...legacy,
      apiVersion: 4,
      items: legacy.items.map((item) => {
        const {
          conversations: _legacyDuplicateThreads,
          recentInstances,
          technicalActivities,
          ...thin
        } = item;
        const directoryInstances: T.AgentRuntimeDirectoryInstance[] = recentInstances
          .slice(0, 12)
          .map((instance) => ({
            agentInstanceId: instance.agentInstanceId,
            ...(instance.canonicalAgentInstanceId
              ? { canonicalAgentInstanceId: instance.canonicalAgentInstanceId }
              : {}),
            ...(instance.agentInstanceAliases?.length
              ? { agentInstanceAliases: [...instance.agentInstanceAliases] }
              : {}),
            runtimeState: instance.runtimeState,
            ...(instance.activityState ? { activityState: instance.activityState } : {}),
            rootPid: instance.rootPid,
            rootStartTimeTicks: instance.rootStartTimeTicks,
            lastSeenAt: instance.lastSeenAt,
            ...(instance.lastActivityAt !== undefined
              ? { lastActivityAt: instance.lastActivityAt }
              : {}),
            ...(instance.workspacePath ? { workspacePath: instance.workspacePath } : {}),
            ...(instance.workloadRef ? { workloadRef: { ...instance.workloadRef } } : {}),
            ...(instance.logicalAgentId ? { logicalAgentId: instance.logicalAgentId } : {}),
            ...(instance.logicalDefinitionId ? { logicalDefinitionId: instance.logicalDefinitionId } : {}),
            ...(instance.logicalScopeMode ? { logicalScopeMode: instance.logicalScopeMode } : {}),
            ...(instance.terminalContextId ? { terminalContextId: instance.terminalContextId } : {}),
            ...(instance.sshConnectionId ? { sshConnectionId: instance.sshConnectionId } : {}),
          }));
        const visibleInstanceIds = [...new Set([
          ...thin.userThreads.flatMap((thread) => thread.agentInstanceIds),
          ...directoryInstances.flatMap((instance) => [
            instance.canonicalAgentInstanceId,
            instance.agentInstanceId,
            ...(instance.agentInstanceAliases ?? []),
          ].filter((value): value is string => Boolean(value))),
        ])].slice(0, 256);
        return {
          ...thin,
          // V3 duplicated every Thread under both `conversations` and `userThreads` and embedded
          // up to one hundred full Runtime records per Agent. V4 is the page read model: the
          // canonical user Thread list is sent once; detailed historical instances remain a
          // separate runtime concern while the most recent records preserve immediate navigation.
          agentInstanceIds: visibleInstanceIds,
          recentInstances: directoryInstances,
          technicalActivities: [...technicalActivities]
            .sort((left, right) => {
              const leftAt = BigInt(left.endedAtUnixNs);
              const rightAt = BigInt(right.endedAtUnixNs);
              return leftAt === rightAt ? 0 : leftAt > rightAt ? -1 : 1;
            })
            .slice(0, 32),
        };
      }),
    };
  }

  @Post('events/tool-evidence')
  @HttpCode(200)
  agentToolEvidence(@Body() f: T.AgentEventQuery) {
    const invocationId = strictIdentityText(f?.invocationId, 512);
    if (!invocationId) throw new BadRequestException('a valid invocationId is required');
    const toolCallId = f?.toolCallId === undefined
      ? undefined
      : strictIdentityText(f.toolCallId, 512);
    if (f?.toolCallId !== undefined && !toolCallId) {
      throw new BadRequestException('toolCallId is invalid');
    }
    return this.agg.agentToolEvidence({ ...f, invocationId, toolCallId });
  }

  @Post('context/system')
  @HttpCode(200)
  systemContextBundle(@Body() query: SystemContextQuery) {
    return this.systemContext.build(query);
  }

  @Get('unknown-learning/status')
  unknownLearningStatus() {
    return this.unknownLearning.status();
  }

  @Post('unknown-learning/clusters')
  @HttpCode(200)
  unknownLearningClusters(@Body() body: { limit?: number } = {}) {
    const status = this.unknownLearning.status();
    const items = this.unknownLearning.listClusters(body.limit);
    return { items, total: status.activeClusters, truncated: items.length < status.activeClusters, status };
  }

  @Post('unknown-learning/families')
  @HttpCode(200)
  unknownLearningFamilies(@Body() body: { limit?: number } = {}) {
    const status = this.unknownLearning.status();
    const items = this.unknownLearning.listFamilies(body.limit);
    return { items, total: status.activeFamilies, truncated: items.length < status.activeFamilies, status };
  }

  @Post('unknown-learning/policies/list')
  @HttpCode(200)
  unknownLearningPolicies(@Body() body: { limit?: number } = {}) {
    const status = this.unknownLearning.status();
    const items = this.unknownLearning.listPolicies(body.limit);
    return {
      items,
      total: status.policies,
      truncated: items.length < status.policies,
      recommendations: this.unknownLearning.listRecommendations(),
      status,
    };
  }

  @Put('unknown-learning/families/:familyId/review')
  @RequireManagementAuth()
  unknownLearningReview(
    @Param('familyId') familyId: string,
    @Body() body: { decision?: 'agent' | 'non_agent' | 'deferred'; reason?: string; expectedRevision?: number },
    @Headers() headers: HeaderBag,
  ) {
    const actor = auditActor(headers);
    try {
      const review = this.unknownLearning.reviewFamily({
        familyId,
        decision: body.decision as 'agent' | 'non_agent' | 'deferred',
        reason: body.reason ?? '',
        expectedRevision: Number(body.expectedRevision),
        actor: actor.id,
      });
      this.audit.record({
        actor,
        action: 'unknown_learning.reviewed',
        resourceType: 'unknown-learning',
        resourceId: review.familyId,
        summary: `Unknown family reviewed as ${review.decision}`,
        result: 'success',
        details: { revision: review.revision, decision: review.decision },
      });
      return review;
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  @Post('unknown-learning/policies')
  @RequireManagementAuth()
  unknownLearningCreatePolicy(
    @Body() body: { familyId?: string; desiredAction?: UnknownLearnedAction; reason?: string },
    @Headers() headers: HeaderBag,
  ) {
    const actor = auditActor(headers);
    if (!body.familyId || !['keep', 'sample', 'aggregate'].includes(body.desiredAction ?? '')) {
      throw new BadRequestException('familyId and a safe keep/sample/aggregate action are required');
    }
    try {
      const policy = this.unknownLearning.createCandidate({
        familyId: body.familyId,
        desiredAction: body.desiredAction!,
        reason: body.reason ?? '',
        actor: actor.id,
      });
      this.audit.record({
        actor,
        action: 'unknown_learning.policy_updated',
        resourceType: 'unknown-learning',
        resourceId: policy.policyId,
        summary: 'Unknown learning policy candidate created',
        result: 'success',
        details: { stage: policy.stage, action: policy.desiredAction, revision: policy.revision },
      });
      return policy;
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  @Put('unknown-learning/policies/:policyId')
  @RequireManagementAuth()
  unknownLearningTransitionPolicy(
    @Param('policyId') policyId: string,
    @Body() body: {
      expectedRevision?: number;
      to?: UnknownPolicyStage;
      reason?: string;
      replayEvents?: number;
      replayAgentConflicts?: number;
      canaryScope?: { kind: 'node' | 'physical_workload'; value: string };
      canaryEvents?: number;
      canaryAgentRecall?: number;
      canaryCriticalDrops?: number;
    },
    @Headers() headers: HeaderBag,
  ) {
    const actor = auditActor(headers);
    try {
      const policy = this.unknownLearning.transition({
        policyId,
        expectedRevision: Number(body.expectedRevision),
        to: body.to as UnknownPolicyStage,
        actor: actor.id,
        reason: body.reason ?? '',
        replayEvents: body.replayEvents,
        replayAgentConflicts: body.replayAgentConflicts,
        canaryScope: body.canaryScope,
        canaryEvents: body.canaryEvents,
        canaryAgentRecall: body.canaryAgentRecall,
        canaryCriticalDrops: body.canaryCriticalDrops,
      });
      this.audit.record({
        actor,
        action: 'unknown_learning.policy_updated',
        resourceType: 'unknown-learning',
        resourceId: policy.policyId,
        summary: `Unknown learning policy moved to ${policy.stage}`,
        result: 'success',
        details: { stage: policy.stage, action: policy.desiredAction, revision: policy.revision },
      });
      return policy;
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  @Post('unknown-learning/policies/:policyId/infrastructure-draft')
  @RequireManagementAuth()
  async unknownLearningCreateInfrastructureDraft(
    @Param('policyId') policyId: string,
    @Body() body: UnknownInfrastructureDraftRequest = {},
    @Headers() headers: HeaderBag,
  ) {
    const actor = auditActor(headers);
    if (!body.workload || typeof body.workload !== 'object') {
      throw new BadRequestException('an exact inventory workload binding is required');
    }
    if (typeof body.reason !== 'string' || !body.reason.trim()) {
      throw new BadRequestException('a bridge reason is required');
    }
    try {
      const recommendation = this.unknownLearning.authorizeInfrastructureDraft({
        policyId,
        expectedPolicyRevision: Number(body.expectedPolicyRevision),
        expectedReviewRevision: Number(body.expectedReviewRevision),
        physicalWorkloadId: body.workload.physicalWorkloadId,
      });
      const result = await this.infrastructureRules.createUnknownRecommendationDraft({
        recommendation,
        request: { ...body, workload: body.workload },
      }, {
        id: actor.id,
        displayName: actor.displayName,
        type: actor.type,
      });
      this.audit.record({
        actor,
        action: result.created
          ? 'unknown_learning.infrastructure_draft_created'
          : 'unknown_learning.infrastructure_draft_reused',
        resourceType: 'unknown-learning',
        resourceId: recommendation.policyId,
        summary: result.created
          ? 'Enforced Unknown recommendation bridged to Infrastructure draft'
          : 'Existing Infrastructure draft reused for Unknown recommendation',
        result: 'success',
        details: {
          unknownPolicyRevision: recommendation.policyRevision,
          unknownFamilyId: recommendation.familyId,
          unknownReviewRevision: recommendation.reviewRevision,
          unknownDesiredAction: recommendation.desiredAction,
          infrastructureRuleId: result.rule.ruleId,
          infrastructureRuleRevision: result.rule.revision,
          lifecycleStage: result.rule.lifecycleStage,
          authority: result.rule.authority,
          scopeBindingHash: result.bridge.scopeBindingHash,
          created: result.created,
          operationDestructive: false,
          reason: body.reason.trim().slice(0, 500),
        },
      });
      return result;
    } catch (error) {
      this.audit.record({
        actor,
        action: 'unknown_learning.infrastructure_draft_rejected',
        resourceType: 'unknown-learning',
        resourceId: policyId.slice(0, 160),
        summary: 'Unknown recommendation Infrastructure draft rejected',
        result: 'failure',
        details: {
          reason: body.reason.trim().slice(0, 500),
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        },
      });
      if (error instanceof InfrastructureRuleError && error.code === 'revision_conflict') {
        throw new ConflictException(error.message);
      }
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  @Put('unknown-learning/config')
  @RequireManagementAuth()
  unknownLearningConfig(
    @Body() body: { enabled?: boolean; reason?: string },
    @Headers() headers: HeaderBag,
  ) {
    if (typeof body.enabled !== 'boolean') throw new BadRequestException('enabled boolean is required');
    const actor = auditActor(headers);
    try {
      const status = this.unknownLearning.setEnabled(body.enabled, { actor: actor.id, reason: body.reason ?? '' });
      this.audit.record({
        actor,
        action: 'unknown_learning.config_updated',
        resourceType: 'unknown-learning',
        resourceId: 'global',
        summary: `Unknown learning ${body.enabled ? 'enabled' : 'disabled'}`,
        result: 'success',
        details: { enabled: body.enabled },
      });
      return status;
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  @Post('stream/findings')
  @HttpCode(200)
  streamFindingList(@Body() f: T.SecurityTimeFilter & { limit?: number }) {
    return this.streamFindings.list(f, f.limit);
  }

  @Post('incidents/list')
  @HttpCode(200)
  incidents(@Body() f: T.IncidentQuery) {
    return this.agg.incidents(f);
  }

  @Put('incidents/:incidentId')
  @RequireManagementAuth()
  updateIncident(@Param('incidentId') incidentId: string, @Body() body: T.IncidentUpdateRequest, @Headers() headers: HeaderBag) {
    const updated = this.agg.updateIncident(incidentId, body);
    if (!updated) throw new NotFoundException('incident not found');
    this.audit.record({
      actor: auditActor(headers),
      action: 'incident.updated',
      resourceType: 'incident',
      resourceId: incidentId,
      summary: `Incident ${updated.status}: ${updated.title}`,
	      details: {
	        status: updated.status,
	        owner: updated.owner,
	        noteUpdated: body.note !== undefined,
	        severity: updated.severity,
	        agentId: updated.agentId,
	        workspacePath: updated.workspacePath,
	        collectorId: updated.collectorId,
	        sourceId: updated.sourceId,
	        traceId: updated.traceId,
	        eventId: updated.lastEventId,
	      },
	    });
    return updated;
  }

  @Post('alerts/list')
  @HttpCode(200)
  alerts(@Body() f: T.AlertListQuery) {
    return this.alerting.list(f);
  }

  @Put('alerts/:alertId')
  @RequireManagementAuth()
  updateAlert(@Param('alertId') alertId: string, @Body() body: T.AlertUpdateRequest, @Headers() headers: HeaderBag) {
    const updated = this.alerting.update(alertId, body);
    if (!updated) throw new NotFoundException('alert not found');
    this.audit.record({
      actor: auditActor(headers),
      action: 'alert.updated',
      resourceType: 'alert',
      resourceId: alertId,
      summary: `Alert ${updated.status}: ${updated.title}`,
	      details: {
	        status: updated.status,
	        owner: updated.owner,
	        noteUpdated: body.note !== undefined,
	        silenceMinutes: body.silenceMinutes,
	        severity: updated.severity,
	        kind: updated.kind,
	        workspacePath: updated.workspacePath,
	        agentId: updated.agentId,
	        collectorId: updated.collectorId,
	        sourceId: updated.sourceId,
	        incidentId: updated.incidentId,
	        eventId: updated.eventId,
	        traceId: updated.traceId,
	        runId: updated.runId,
	        sessionId: updated.sessionId,
	        taskId: updated.labels?.taskId,
	        objectiveId: updated.labels?.objectiveId,
	        issueId: updated.labels?.issueId,
	      },
	    });
    return updated;
  }

  @Get('alerts/config')
  alertConfig() {
    return this.alerting.getConfig();
  }

  @Post('remediations/list')
  @HttpCode(200)
  remediations(@Body() f: T.RemediationQuery) {
    return this.remediation.list(f);
  }

  @Put('remediations/:taskId')
  @RequireManagementAuth()
  updateRemediation(@Param('taskId') taskId: string, @Body() body: T.RemediationUpdateRequest, @Headers() headers: HeaderBag) {
    const updated = this.remediation.update(taskId, body);
    if (!updated) throw new NotFoundException('remediation not found');
    this.audit.record({
      actor: auditActor(headers),
      action: 'remediation.updated',
      resourceType: 'remediation',
      resourceId: taskId,
      summary: `Remediation ${updated.status}: ${updated.title}`,
	      details: {
	        status: updated.status,
	        owner: updated.owner,
	        noteUpdated: body.note !== undefined,
	        dueAt: updated.dueAt,
	        completedStepIds: body.completedStepIds,
	        sourceType: updated.sourceType,
	        sourceId: updated.sourceId,
	        agentId: updated.agentId,
	        workspacePath: updated.workspacePath,
	        collectorId: updated.collectorId,
	        ingestionSourceId: updated.ingestionSourceId,
	        incidentId: updated.incidentId,
	        alertId: updated.alertId,
	        eventId: updated.eventId,
	        traceId: updated.traceId,
	        objectiveId: updated.labels?.objectiveId,
	        issueId: updated.sourceType === 'coverage' ? updated.sourceId : updated.labels?.issueId,
	      },
	    });
    return updated;
  }

  @Post('agents/inventory')
  @HttpCode(200)
  agentInventory(@Body() f: T.AgentInventoryQuery) {
    return this.agg.storedAgentInventory(f);
  }

  @Post('agents/directory')
  @HttpCode(200)
  async agentDirectory(@Body() f: T.AgentInventoryQuery) {
    const window = await this.agg.storedAgentInventory(f);
    const lifecyclePage = this.observedAssets.list({
      subjectAssetType: 'agent',
      q: f.q,
      limit: 200,
    });
    const runtimeState = this.agentRuntimeState.list({ includeShadow: true, limit: 100_000 });
    const activeSubjectAssetIds = currentAgentSubjectAssetIds(
      lifecyclePage.items,
      runtimeState.items,
      (subjectAssetId) => this.observedAssets.detail(subjectAssetId),
    );
    const lifecycle = lifecyclePage.nextCursor
      ? {
          ...lifecyclePage,
          activeSubjectAssetIds,
          readStatus: {
            ...lifecyclePage.readStatus,
            partial: true,
            reasons: [...lifecyclePage.readStatus.reasons, 'agent_directory_truncated'],
          },
        }
      : { ...lifecyclePage, activeSubjectAssetIds };
    return mergePersistentAgentDirectory(window, lifecycle, this.agentMetadata.list(), f);
  }

  @Post('agents/instance-metrics')
  @HttpCode(200)
  agentInstanceMetrics(@Body() f: T.AgentInstanceMetricsQuery) {
    return this.agg.storedAgentInstanceMetrics(f);
  }

  /** Issue a collector-scoped fencing epoch without routing anything through event judgment/L1. */
  @Post('runtime/lease')
  @HttpCode(200)
  @SkipWrap()
  issueAgentRuntimeLease(
    @Body() body: T.AgentRuntimeLeaseRequest,
    @Headers() headers: HeaderBag,
  ): T.AgentRuntimeLeaseAck {
    const sourceId = headerValue(headers, 'x-anysentry-source-id');
    const token = headerValue(headers, 'x-anysentry-ingest-token') ?? bearerToken(headers);
    const resolution = this.sources.resolve({
      sourceId,
      token,
      collectorId: body?.collectorId,
      type: 'forwarder',
    });
    if (!resolution.accepted) {
      const reason = resolution.reason ?? 'runtime lease rejected';
      this.recordRejectedIngest(resolution, reason, {
        sourceId,
        sourceType: 'forwarder',
        collectorId: body?.collectorId,
        endpoint: 'runtime/lease',
        rejectedEvents: 1,
      });
      return this.agentRuntimeState.rejectLease(body, reason, 'source_rejected');
    }
    if (
      body?.collectorId &&
      resolution.source?.collectorId !== body.collectorId
    ) {
      const reason = 'source collector does not match runtime lease collector';
      this.recordRejectedIngest(resolution, reason, {
        sourceId,
        sourceType: 'forwarder',
        collectorId: body.collectorId,
        endpoint: 'runtime/lease',
        rejectedEvents: 1,
      });
      return this.agentRuntimeState.rejectLease(body, reason, 'collector_conflict');
    }
    return this.agentRuntimeState.issueLease(body);
  }

  /** Accept a complete forwarder lifecycle snapshot without routing it through event judgment/L1. */
  @Post('runtime/snapshot')
  @HttpCode(200)
  @SkipWrap()
  ingestAgentRuntimeSnapshot(
    @Body() body: T.AgentRuntimeSnapshotRequest,
    @Headers() headers: HeaderBag,
  ): T.AgentRuntimeSnapshotAck {
    const sourceId = headerValue(headers, 'x-anysentry-source-id');
    const token = headerValue(headers, 'x-anysentry-ingest-token') ?? bearerToken(headers);
    const resolution = this.sources.resolve({
      sourceId,
      token,
      collectorId: body?.collectorId,
      type: 'forwarder',
    });
    if (!resolution.accepted) {
      const reason = resolution.reason ?? 'runtime snapshot rejected';
      this.recordRejectedIngest(resolution, reason, {
        sourceId,
        sourceType: 'forwarder',
        collectorId: body?.collectorId,
        endpoint: 'runtime/snapshot',
        rejectedEvents: 1,
      });
      return this.agentRuntimeState.rejectSnapshot(body, reason, 'source_rejected');
    }
    if (
      body?.collectorId &&
      resolution.source?.collectorId !== body.collectorId
    ) {
      const reason = 'source collector does not match runtime snapshot collector';
      this.recordRejectedIngest(resolution, reason, {
        sourceId,
        sourceType: 'forwarder',
        collectorId: body.collectorId,
        endpoint: 'runtime/snapshot',
        rejectedEvents: 1,
      });
      return this.agentRuntimeState.rejectSnapshot(body, reason, 'collector_conflict');
    }
    // The source identity is authenticated at this boundary. Pass it as server-only context so a
    // Source-bound management registration can be resolved without trusting producer fields; the
    // runtime snapshot wire contract itself remains unchanged.
    return this.agentRuntimeState.recordSnapshot(body, undefined, resolution.source?.sourceId ?? sourceId);
  }

  @Post('runtime/instances')
  @HttpCode(200)
  agentRuntimeInstances(@Body() query: T.AgentRuntimeStateQuery = {}): T.AgentRuntimeStateList {
    return this.agentRuntimeState.list(query);
  }

  @Post('runtime/summary')
  @HttpCode(200)
  agentRuntimeSummary(@Body() query: T.AgentRuntimeStateQuery = {}): T.AgentRuntimeStateSummaryResponse {
    const { summary, updateTime } = this.agentRuntimeState.list(query);
    return { summary, updateTime };
  }

  @Post('identity/ai-review')
  @HttpCode(200)
  @RequireManagementAuth()
  async runIdentityAiReview(@Body() body: T.IdentityAiReviewRequest, @Headers() headers: HeaderBag) {
    const result = await this.identityReview.run(body);
    this.audit.record({
      actor: auditActor(headers),
      action: 'agent.identity_ai_review.completed',
      resourceType: body.targetType === 'event' ? 'event' : 'agent',
      resourceId: body.eventId ?? body.agentAssetId ?? result.reviewId,
      summary: result.status === 'succeeded'
        ? `AI identity review: ${result.verdict}`
        : `AI identity review failed: ${result.error ?? 'unknown error'}`,
      details: {
        reviewId: result.reviewId,
        targetType: result.targetType,
        eventId: result.eventId,
        agentAssetId: result.agentAssetId,
        status: result.status,
        verdict: result.verdict,
        confidence: result.confidence,
        evidenceDigest: result.evidenceDigest,
        provider: result.provider,
        model: result.model,
      },
    });
    return result;
  }

  @Get('identity/ai-reviews')
  @RequireManagementAuth()
  identityAiReviews(
    @Query('targetType') targetType?: string,
    @Query('eventId') eventId?: string,
    @Query('agentAssetId') agentAssetId?: string,
  ) {
    return { items: this.identityReview.list(targetType, eventId, agentAssetId), updateTime: new Date().toISOString() };
  }

  @Post('workspaces/inventory')
  @HttpCode(200)
  async workspaceInventory(@Body() f: T.WorkspaceInventoryQuery) {
    return this.agg.storedWorkspaceInventory(f);
  }

  @Get('workspaces/directory')
  workspaceDirectoryList() {
    return {
      items: this.workspaceDirectory.directory(),
      status: this.workspaceDirectory.status(),
      updateTime: new Date().toISOString(),
    };
  }

  @Get('workspaces/bindings')
  workspaceBindingHistory(
    @Query('agentAssetId') agentAssetId?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    return {
      items: this.workspaceDirectory.bindingHistory(agentAssetId, workspaceId),
      updateTime: new Date().toISOString(),
    };
  }

  @Get('agents/metadata')
  agentMetadataList() {
    return { items: this.agentMetadata.list(), updateTime: new Date().toISOString().slice(0, 19).replace('T', ' ') };
  }

  @Put('agents/:agentId/metadata')
  @RequireManagementAuth()
  updateAgentMetadata(@Param('agentId') agentId: string, @Body() body: T.AgentMetadataUpdateRequest, @Headers() headers: HeaderBag) {
    const updated = this.agentMetadata.update(agentId, body);
    this.audit.record({
      actor: auditActor(headers),
      action: 'agent.metadata.updated',
      resourceType: 'agent',
      resourceId: updated.agentAssetId,
      summary: `Agent metadata updated: ${updated.displayName || updated.agentId}`,
      details: {
        agentId: updated.agentId,
        agentAssetId: updated.agentAssetId,
        workspacePath: updated.workspacePath,
        displayName: updated.displayName,
        owner: updated.owner,
        team: updated.team,
        environment: updated.environment,
        criticality: updated.criticality,
        tags: updated.tags,
        noteUpdated: body.note !== undefined,
      },
    });
    return updated;
  }

  @Put('agents/:agentId/review')
  @RequireManagementAuth()
  reviewAgent(@Param('agentId') agentId: string, @Body() body: T.AgentReviewRequest, @Headers() headers: HeaderBag) {
    if (!['confirmed_agent', 'unknown', 'non_agent', 'clear'].includes(body.decision)) {
      throw new BadRequestException('decision must be confirmed_agent, unknown, non_agent, or clear');
    }
    const actor = auditActor(headers);
    const updated = this.agentMetadata.review(
      agentId,
      body,
      actor.displayName ? `${actor.displayName} (${actor.id})` : actor.id,
    );
    this.agg.invalidateWindowCache();
    this.audit.record({
      actor,
      action: body.decision === 'clear' ? 'agent.review.cleared' : 'agent.review.updated',
      resourceType: 'agent',
      resourceId: updated.agentAssetId,
      summary:
        body.decision === 'confirmed_agent'
          ? `Agent confirmed by reviewer: ${updated.displayName || updated.agentId}`
          : body.decision === 'unknown'
            ? `Agent returned to observation by reviewer: ${updated.displayName || updated.agentId}`
          : body.decision === 'non_agent'
            ? `Unknown identity excluded by reviewer: ${updated.displayName || updated.agentId}`
            : `Agent review cleared: ${updated.displayName || updated.agentId}`,
      details: {
        agentId: updated.agentId,
        agentAssetId: updated.agentAssetId,
        workspacePath: updated.workspacePath,
        decision: updated.reviewDecision ?? 'clear',
        reviewRevision: updated.reviewRevision,
        reviewEffectiveAt: updated.reviewEffectiveAt,
        expectedRevision: body.expectedRevision,
        identityKeyCount: updated.reviewIdentityKeys?.length ?? 0,
        physicalWorkloadId: updated.reviewPhysicalWorkloadId,
        agentInstanceId: updated.reviewAgentInstanceId,
        noteUpdated: body.note !== undefined,
      },
    });
    return updated;
  }

  @Post('agents/topology')
  @HttpCode(200)
  async agentTopology(@Body() f: T.AgentTopologyQuery) {
    return this.agg.storedAgentTopology(f);
  }

  @Post('collectors/heartbeat')
  collectorHeartbeat(@Body() body: T.CollectorHeartbeatRequest, @Headers() headers: HeaderBag) {
    const requestSourceId = body.sourceId ?? headerValue(headers, 'x-anysentry-source-id');
    const requestToken = body.token ?? headerValue(headers, 'x-anysentry-ingest-token') ?? bearerToken(headers);
    const requestSourceType = body.sourceType ?? 'forwarder';
    const requestCollectorId = canonicalCollectorId(body.collectorId);
    const sourceResolution = this.sources.resolve({
      sourceId: requestSourceId,
      token: requestToken,
      collectorId: requestCollectorId,
      workspacePath: body.workspacePath,
      sourceName: body.sourceName,
      type: requestSourceType,
    });

    if (!sourceResolution.accepted) {
      const reason = sourceResolution.reason ?? 'collector heartbeat rejected';
      this.recordRejectedIngest(sourceResolution, reason, {
        sourceId: requestSourceId,
        sourceName: body.sourceName,
        sourceType: requestSourceType,
        collectorId: requestCollectorId,
        workspacePath: body.workspacePath,
        nodeName: body.nodeName,
        endpoint: 'collectors/heartbeat',
        rejectedEvents: 1,
      });
      return {
        accepted: false,
        collectorId: requestCollectorId ?? sourceResolution.source?.collectorId ?? body.podName ?? body.nodeName ?? 'unknown-collector',
        sourceId: sourceResolution.source?.sourceId,
        receivedAt: new Date().toISOString(),
        reason,
      } satisfies T.CollectorHeartbeatAck;
    }
    if (
      requestCollectorId &&
      sourceResolution.source?.collectorId &&
      canonicalCollectorId(sourceResolution.source.collectorId) !== requestCollectorId
    ) {
      const reason = 'source collector does not match heartbeat collector';
      this.recordRejectedIngest(sourceResolution, reason, {
        sourceId: requestSourceId,
        sourceName: body.sourceName,
        sourceType: requestSourceType,
        collectorId: requestCollectorId,
        workspacePath: body.workspacePath,
        nodeName: body.nodeName,
        endpoint: 'collectors/heartbeat',
        rejectedEvents: 1,
      });
      return {
        accepted: false,
        collectorId: requestCollectorId,
        sourceId: sourceResolution.source.sourceId,
        receivedAt: new Date().toISOString(),
        reason,
      } satisfies T.CollectorHeartbeatAck;
    }

    const resolvedCollectorId = requestCollectorId ?? canonicalCollectorId(sourceResolution.source?.collectorId);
    const rec = this.judge.recordCollectorHeartbeat({
      ...body,
      collectorId: resolvedCollectorId,
      // Raw-only evidence is accepted exclusively through the parsed Observer line ingress.
      execEvidence: undefined,
      filterMetrics: trustedUnknownReasonMetrics(
        body.filterMetrics,
        isTrustedCollectorProducer(sourceResolution, resolvedCollectorId),
      ),
    }, Date.now(), 'forwarder');
    this.sources.recordAccepted(sourceResolution, 'heartbeat', { collectorId: rec.collectorId, workspacePath: body.workspacePath });
    this.agg.invalidateWindowCache();
    if (sourceResolution.source) {
      this.alerting.observeSourceCheckIn({
        source: sourceResolution.source,
        sourceId: requestSourceId,
        sourceName: body.sourceName,
        sourceType: requestSourceType,
        collectorId: rec.collectorId,
        workspacePath: body.workspacePath,
        status: rec.status === 'error' ? 'error' : 'ok',
        message: body.message,
        at: rec.at,
      });
    }
    return { accepted: true, collectorId: rec.collectorId, sourceId: sourceResolution.source?.sourceId, receivedAt: new Date(rec.at).toISOString() } satisfies T.CollectorHeartbeatAck;
  }

  @Post('collectors/health')
  @HttpCode(200)
  async collectorHealth(@Body() f: T.CollectorHealthQuery) {
    return this.agg.storedCollectorHealth(f);
  }

  @Post('sources/list')
  @HttpCode(200)
  async ingestionSources(@Body() f: T.IngestionSourceQuery) {
    await this.sources.refreshDistributedCurrentState();
    return this.sources.list(f);
  }

  @Post('sources')
  @RequireManagementAuth()
  createIngestionSource(@Body() body: T.IngestionSourceUpdateRequest, @Headers() headers: HeaderBag) {
    const result = this.sources.create(body);
    const correlationVisible = correlationCaptureRollout().trustedCorrelation !== 'off';
    this.audit.record({
      actor: auditActor(headers),
      action: 'source.updated',
      resourceType: 'source',
      resourceId: result.source.sourceId,
      summary: `Ingestion source updated: ${result.source.name}`,
      details: {
        sourceId: result.source.sourceId,
        name: result.source.name,
        type: result.source.type,
        enabled: result.source.enabled,
        collectorId: result.source.collectorId,
        workspacePath: result.source.workspacePath,
        issued: Boolean(result.token),
        ...(correlationVisible
          ? {
              correlationClaimsEnabled: result.source.correlationClaims?.enabled === true,
              correlationClaimAuthority: result.source.correlationClaims?.authority,
              correlationClaimBindingCount: result.source.correlationClaims
                ? Object.values(result.source.correlationClaims.bindings).reduce((total, values) => total + values.length, 0)
                : 0,
            }
          : {}),
      },
    });
    return result;
  }

  @Put('sources/:sourceId')
  @RequireManagementAuth()
  updateIngestionSource(@Param('sourceId') sourceId: string, @Body() body: T.IngestionSourceUpdateRequest, @Headers() headers: HeaderBag) {
    const result = this.sources.update(sourceId, body);
    const correlationVisible = correlationCaptureRollout().trustedCorrelation !== 'off';
    this.audit.record({
      actor: auditActor(headers),
      action: 'source.updated',
      resourceType: 'source',
      resourceId: result.source.sourceId,
      summary: `Ingestion source updated: ${result.source.name}`,
      details: {
        sourceId: result.source.sourceId,
        name: result.source.name,
        type: result.source.type,
        enabled: result.source.enabled,
        collectorId: result.source.collectorId,
        workspacePath: result.source.workspacePath,
        ...(correlationVisible
          ? {
              correlationClaimsEnabled: result.source.correlationClaims?.enabled === true,
              correlationClaimAuthority: result.source.correlationClaims?.authority,
              correlationClaimBindingCount: result.source.correlationClaims
                ? Object.values(result.source.correlationClaims.bindings).reduce((total, values) => total + values.length, 0)
                : 0,
            }
          : {}),
      },
    });
    return result;
  }

  @Post('sources/:sourceId/rotate-token')
  @RequireManagementAuth()
  rotateIngestionSourceToken(@Param('sourceId') sourceId: string, @Headers() headers: HeaderBag) {
    const result = this.sources.rotateToken(sourceId);
    if (!result) throw new NotFoundException('source not found');
    this.audit.record({
      actor: auditActor(headers),
      action: 'source.token_rotated',
      resourceType: 'source',
      resourceId: result.source.sourceId,
      summary: `Ingestion source token rotated: ${result.source.name}`,
      details: {
        sourceId: result.source.sourceId,
        name: result.source.name,
        type: result.source.type,
        collectorId: result.source.collectorId,
        workspacePath: result.source.workspacePath,
        issued: Boolean(result.token),
      },
    });
    return result;
  }

  @Post('sources/check-in')
  ingestionSourceCheckIn(@Body() body: T.IngestionSourceCheckInRequest, @Headers() headers: HeaderBag) {
    const sourceId = body.sourceId ?? headerValue(headers, 'x-anysentry-source-id');
    const token = body.token ?? headerValue(headers, 'x-anysentry-ingest-token') ?? bearerToken(headers);
    const requestSourceType = body.sourceType ?? 'forwarder';
    const resolution = this.sources.resolve({
      sourceId,
      token,
      collectorId: body.collectorId,
      workspacePath: body.workspacePath,
      sourceName: body.sourceName,
      type: requestSourceType,
    });
    if (!resolution.accepted) {
      const reason = resolution.reason ?? 'check-in rejected';
      this.recordRejectedIngest(resolution, reason, {
        sourceId,
        sourceName: body.sourceName,
        sourceType: requestSourceType,
        collectorId: body.collectorId,
        workspacePath: body.workspacePath,
        endpoint: 'sources/check-in',
        rejectedEvents: 1,
      });
      return { accepted: false, sourceId: resolution.source?.sourceId, receivedAt: new Date().toISOString(), reason };
    }
    this.sources.recordAccepted(resolution, 'heartbeat', { collectorId: body.collectorId, workspacePath: body.workspacePath });
    this.agg.invalidateWindowCache();
    this.alerting.observeSourceCheckIn({
      source: resolution.source,
      sourceId,
      sourceName: body.sourceName,
      sourceType: requestSourceType,
      collectorId: body.collectorId,
      workspacePath: body.workspacePath,
      status: body.status ?? 'ok',
      message: body.message,
    });
    return { accepted: true, sourceId: resolution.source?.sourceId, receivedAt: new Date().toISOString() };
  }

  @Post('coverage/overview')
  @HttpCode(200)
  async coverageOverview(@Body() f: T.CoverageQuery) {
    const coverage = await this.agg.storedCoverageOverview(f);
    const scoped = Boolean(f.issueId || f.type || f.workspacePath || f.agentId || f.collectorId || f.sourceId);
    this.alerting.observeCoverageList(coverage.issues, Date.now(), {
      resolveMissing: scoped,
      scope: {
        issueId: f.issueId,
        type: f.type && f.type !== 'all' ? f.type : undefined,
        workspacePath: f.workspacePath,
        agentId: f.agentId,
        collectorId: f.collectorId,
        sourceId: f.sourceId,
      },
    });
    return coverage;
  }

  @Post('maintenance/list')
  @HttpCode(200)
  maintenanceWindows(@Body() f: T.MaintenanceWindowQuery) {
    return this.maintenance.list(f);
  }

  @Post('maintenance/windows')
  @RequireManagementAuth()
  createMaintenanceWindow(@Body() body: T.MaintenanceWindowUpdateRequest, @Headers() headers: HeaderBag) {
    const updated = this.maintenance.upsert(undefined, body);
    this.audit.record({
      actor: auditActor(headers),
      action: 'maintenance.window.updated',
      resourceType: 'maintenance',
      resourceId: updated.windowId,
      summary: `Maintenance window updated: ${updated.title}`,
      details: {
        windowId: updated.windowId,
        targetType: updated.targetType,
        targetId: updated.targetId,
        startAt: updated.startAt,
        endAt: updated.endAt,
        enabled: updated.enabled,
        status: updated.status,
        owner: updated.owner,
      },
    });
    return updated;
  }

  @Put('maintenance/windows/:windowId')
  @RequireManagementAuth()
  updateMaintenanceWindow(@Param('windowId') windowId: string, @Body() body: T.MaintenanceWindowUpdateRequest, @Headers() headers: HeaderBag) {
    if (!this.maintenance.has(windowId)) throw new NotFoundException('maintenance window not found');
    const updated = this.maintenance.upsert(windowId, body);
    this.audit.record({
      actor: auditActor(headers),
      action: 'maintenance.window.updated',
      resourceType: 'maintenance',
      resourceId: updated.windowId,
      summary: `Maintenance window updated: ${updated.title}`,
      details: {
        windowId: updated.windowId,
        targetType: updated.targetType,
        targetId: updated.targetId,
        startAt: updated.startAt,
        endAt: updated.endAt,
        enabled: updated.enabled,
        status: updated.status,
        owner: updated.owner,
      },
    });
    return updated;
  }

  @Get('notifications/config')
  notificationConfig(@Query() query: T.NotificationConfigQuery) {
    return this.notifications.config(query);
  }

  @Post('notifications/channels')
  @RequireManagementAuth()
  createNotificationChannel(@Body() body: T.NotificationChannelUpdateRequest, @Headers() headers: HeaderBag) {
    const updated = this.notifications.upsertChannel(undefined, body);
    this.audit.record({
      actor: auditActor(headers),
      action: 'notification.channel.updated',
      resourceType: 'notification',
      resourceId: updated.channelId,
      summary: `Notification channel updated: ${updated.name}`,
      details: {
        channelId: updated.channelId,
        name: updated.name,
        type: updated.type,
        enabled: updated.enabled,
        endpointPreview: updated.endpointPreview,
      },
    });
    return updated;
  }

  @Put('notifications/channels/:channelId')
  @RequireManagementAuth()
  updateNotificationChannel(@Param('channelId') channelId: string, @Body() body: T.NotificationChannelUpdateRequest, @Headers() headers: HeaderBag) {
    if (!this.notifications.hasChannel(channelId)) throw new NotFoundException('notification channel not found');
    const updated = this.notifications.upsertChannel(channelId, body);
    this.audit.record({
      actor: auditActor(headers),
      action: 'notification.channel.updated',
      resourceType: 'notification',
      resourceId: updated.channelId,
      summary: `Notification channel updated: ${updated.name}`,
      details: {
        channelId: updated.channelId,
        name: updated.name,
        type: updated.type,
        enabled: updated.enabled,
        endpointPreview: updated.endpointPreview,
      },
    });
    return updated;
  }

  @Post('notifications/routes')
  @RequireManagementAuth()
  createNotificationRoute(@Body() body: T.NotificationRouteUpdateRequest, @Headers() headers: HeaderBag) {
    const updated = this.notifications.upsertRoute(undefined, body);
    this.audit.record({
      actor: auditActor(headers),
      action: 'notification.route.updated',
      resourceType: 'notification',
      resourceId: updated.routeId,
      summary: `Notification route updated: ${updated.name}`,
	      details: {
	        routeId: updated.routeId,
	        name: updated.name,
	        enabled: updated.enabled,
	        minSeverity: updated.minSeverity,
	        kinds: updated.kinds,
	        channelIds: updated.channelIds,
	        workspacePath: updated.workspacePath,
	        agentId: updated.agentId,
	        collectorId: updated.collectorId,
	        sourceId: updated.sourceId,
	        owner: updated.owner,
	        team: updated.team,
	        q: updated.q,
	      },
	    });
    return updated;
  }

  @Put('notifications/routes/:routeId')
  @RequireManagementAuth()
  updateNotificationRoute(@Param('routeId') routeId: string, @Body() body: T.NotificationRouteUpdateRequest, @Headers() headers: HeaderBag) {
    if (!this.notifications.hasRoute(routeId)) throw new NotFoundException('notification route not found');
    const updated = this.notifications.upsertRoute(routeId, body);
    this.audit.record({
      actor: auditActor(headers),
      action: 'notification.route.updated',
      resourceType: 'notification',
      resourceId: updated.routeId,
      summary: `Notification route updated: ${updated.name}`,
	      details: {
	        routeId: updated.routeId,
	        name: updated.name,
	        enabled: updated.enabled,
	        minSeverity: updated.minSeverity,
	        kinds: updated.kinds,
	        channelIds: updated.channelIds,
	        workspacePath: updated.workspacePath,
	        agentId: updated.agentId,
	        collectorId: updated.collectorId,
	        sourceId: updated.sourceId,
	        owner: updated.owner,
	        team: updated.team,
	        q: updated.q,
	      },
	    });
    return updated;
  }

  @Post('objectives/list')
  @HttpCode(200)
  objectivesList(@Body() f: T.ObjectiveQuery) {
    return this.objectives.list(f);
  }

  @Post('objectives')
  @RequireManagementAuth()
  createObjective(@Body() body: T.ObjectiveUpdateRequest, @Headers() headers: HeaderBag) {
    const updated = this.objectives.upsert(undefined, body);
    this.audit.record({
      actor: auditActor(headers),
      action: 'objective.updated',
      resourceType: 'objective',
      resourceId: updated.objectiveId,
      summary: `Objective updated: ${updated.name}`,
      details: {
        objectiveId: updated.objectiveId,
        name: updated.name,
        enabled: updated.enabled,
        targetType: updated.targetType,
        targetId: updated.targetId,
        metric: updated.metric,
        comparator: updated.comparator,
        threshold: updated.threshold,
        severity: updated.severity,
        status: updated.status,
        currentValue: updated.currentValue,
      },
    });
    return updated;
  }

  @Put('objectives/:objectiveId')
  @RequireManagementAuth()
  updateObjective(@Param('objectiveId') objectiveId: string, @Body() body: T.ObjectiveUpdateRequest, @Headers() headers: HeaderBag) {
    if (!this.objectives.has(objectiveId)) throw new NotFoundException('objective not found');
    const updated = this.objectives.upsert(objectiveId, body);
    this.audit.record({
      actor: auditActor(headers),
      action: 'objective.updated',
      resourceType: 'objective',
      resourceId: updated.objectiveId,
      summary: `Objective updated: ${updated.name}`,
      details: {
        objectiveId: updated.objectiveId,
        name: updated.name,
        enabled: updated.enabled,
        targetType: updated.targetType,
        targetId: updated.targetId,
        metric: updated.metric,
        comparator: updated.comparator,
        threshold: updated.threshold,
        severity: updated.severity,
        status: updated.status,
        currentValue: updated.currentValue,
      },
    });
    return updated;
  }

  @Post('audit/list')
  @HttpCode(200)
  auditLog(@Body() f: T.AuditQuery) {
    return this.audit.list(f);
  }

  @Post('users/list')
  @HttpCode(200)
  usersList(@Body() query: T.PlatformUserQuery) {
    return this.users.list(query);
  }

  @Post('users')
  @RequireManagementAuth()
  createUser(@Body() body: T.PlatformUserUpdateRequest, @Headers() headers: HeaderBag) {
    const actor = auditActor(headers);
    const updated = this.users.upsert(undefined, body, actor.id);
    this.audit.record({
      actor,
      action: 'user.updated',
      resourceType: 'user',
      resourceId: updated.userId,
      summary: `Platform user created: ${updated.username}`,
      details: {
        userId: updated.userId,
        username: updated.username,
        displayName: updated.displayName,
        role: updated.role,
        status: updated.status,
        team: updated.team,
      },
    });
    return updated;
  }

  @Put('users/:userId')
  @RequireManagementAuth()
  updateUser(
    @Param('userId') userId: string,
    @Body() body: T.PlatformUserUpdateRequest,
    @Headers() headers: HeaderBag,
  ) {
    if (!this.users.has(userId)) throw new NotFoundException('platform user not found');
    const actor = auditActor(headers);
    const updated = this.users.upsert(userId, body, actor.id);
    this.audit.record({
      actor,
      action: 'user.updated',
      resourceType: 'user',
      resourceId: updated.userId,
      summary: `Platform user updated: ${updated.username}`,
      details: {
        userId: updated.userId,
        username: updated.username,
        displayName: updated.displayName,
        role: updated.role,
        status: updated.status,
        team: updated.team,
      },
    });
    return updated;
  }

  @Post('evidence/bundle')
  @HttpCode(200)
  async evidenceBundle(@Body() query: T.EvidenceBundleQuery = {}): Promise<T.EvidenceBundle> {
    const snapshotAsOf = query.snapshotAsOf ?? new Date().toISOString();
    const timeFilter: T.SecurityTimeFilter = {
      timeType: query.timeType ?? 'last_30d',
      startTime: query.startTime,
      endTime: query.endTime,
      snapshotAsOf,
      scope: query.scope,
      classificationView: query.classificationView ?? 'as_observed',
    };
    const limit = Math.max(10, Math.min(100, query.limit ?? 60));
    const readStoredEvents = async (filter: T.AgentEventQuery): Promise<T.AgentEventList> =>
      this.observedAssets.annotateEventList(await this.agg.storedAgentEvents(filter));
    const readStoredTimeline = async (filter: T.AgentEventQuery): Promise<T.AgentTimeline> =>
      this.observedAssets.annotateTimeline(await this.agg.storedAgentTimeline(filter));
    const explicitAuditId = selector(query.auditId, 180);
    const explicitEdgeId = selector(query.edgeId, 180);
    const explicitEventId = selector(query.eventId, 180);
    const explicitSubjectAssetId = strictIdentityText(query.subjectAssetId, 240);
    const explicitIncidentId = selector(query.incidentId, 180);
    const explicitAlertId = selector(query.alertId, 180);
    const explicitTaskId = selector(query.taskId, 180);
    const explicitObjectiveId = selector(query.objectiveId, 180);
    const explicitIssueId = selector(query.issueId, 180);
    const explicitDeliveryId = selector(query.deliveryId, 180);
    const explicitWindowId = selector(query.windowId, 180);
    const primaryType: T.EvidenceBundlePrimaryType = explicitAuditId ? 'audit' : explicitEdgeId ? 'topology' : explicitDeliveryId ? 'notification' : explicitWindowId ? 'maintenance' : explicitObjectiveId ? 'objective' : explicitTaskId ? 'remediation' : explicitAlertId ? 'alert' : explicitIncidentId ? 'incident' : explicitEventId ? 'event' : explicitIssueId ? 'coverage' : 'scope';
    const primaryId = explicitAuditId ?? explicitEdgeId ?? explicitDeliveryId ?? explicitWindowId ?? explicitObjectiveId ?? explicitTaskId ?? explicitAlertId ?? explicitIncidentId ?? explicitEventId ?? explicitIssueId;

    const auditRecord = explicitAuditId
      ? this.audit.list({ ...timeFilter, auditId: explicitAuditId, limit: 1 }).items.find((item) => item.auditId === explicitAuditId)
      : undefined;
    const topologyEdge = explicitEdgeId
      ? this.agg.agentTopology({ ...timeFilter, edgeId: explicitEdgeId, includeBenign: true, limit: 20 }).edges.find((item) => item.edgeId === explicitEdgeId)
      : undefined;
    const auditEventId = auditDetailText(auditRecord, 'eventId');
    const auditIncidentId = auditResourceId(auditRecord, 'incident') ?? auditDetailText(auditRecord, 'incidentId');
    const auditAlertId = auditResourceId(auditRecord, 'alert') ?? auditDetailText(auditRecord, 'alertId');
    const auditTaskId = auditResourceId(auditRecord, 'remediation') ?? auditDetailText(auditRecord, 'taskId');
    const auditObjectiveId = auditResourceId(auditRecord, 'objective') ?? auditDetailText(auditRecord, 'objectiveId');
    const auditDeliveryId = auditDetailText(auditRecord, 'deliveryId') ?? (auditRecord?.resourceType === 'notification' && auditRecord.action === 'notification.delivery_failed' ? auditRecord.resourceId : undefined);
    const auditWindowId = auditResourceId(auditRecord, 'maintenance') ?? auditDetailText(auditRecord, 'windowId');
    const auditIssueId = auditDetailText(auditRecord, 'issueId') ?? (auditDetailText(auditRecord, 'sourceType') === 'coverage' ? auditDetailText(auditRecord, 'sourceId') : undefined);
    const auditWorkspacePath = auditDetailText(auditRecord, 'workspacePath') ?? (auditDetailText(auditRecord, 'targetType') === 'workspace' ? auditDetailText(auditRecord, 'targetId') : undefined);
    const auditAgentId = auditDetailText(auditRecord, 'agentId') ?? (auditDetailText(auditRecord, 'targetType') === 'agent' ? auditDetailText(auditRecord, 'targetId') : undefined);
    const auditCollectorId = auditDetailText(auditRecord, 'collectorId') ?? (auditDetailText(auditRecord, 'targetType') === 'collector' ? auditDetailText(auditRecord, 'targetId') : undefined);
    const auditSourceId = auditResourceId(auditRecord, 'source') ?? auditDetailText(auditRecord, 'sourceId') ?? (auditDetailText(auditRecord, 'targetType') === 'source' ? auditDetailText(auditRecord, 'targetId') : undefined);

    const relatedDeliveryId = explicitDeliveryId ?? auditDeliveryId;
    const notificationDelivery = relatedDeliveryId
      ? this.notifications.config({ deliveryId: relatedDeliveryId, limit: 1 }).deliveries.find((item) => item.deliveryId === relatedDeliveryId)
      : undefined;
    const relatedWindowId = explicitWindowId ?? auditWindowId;
    const maintenanceWindow = relatedWindowId
      ? this.maintenance.list({ ...timeFilter, windowId: relatedWindowId, status: 'all', limit: 1 }).items.find((item) => item.windowId === relatedWindowId)
      : undefined;

    let remediation = explicitTaskId ? this.remediation.list({ ...timeFilter, taskId: explicitTaskId, status: 'all', limit: 1 }, { refresh: false }).items[0] : undefined;
    if (!remediation && auditTaskId) {
      remediation = this.remediation.list({ ...timeFilter, taskId: auditTaskId, status: 'all', limit: 1 }, { refresh: false }).items[0];
    }
    if (!remediation && notificationDelivery?.taskId) {
      remediation = this.remediation.list({ ...timeFilter, taskId: notificationDelivery.taskId, status: 'all', limit: 1 }, { refresh: false }).items[0];
    }
    if (!remediation && explicitIssueId) {
      // A directly requested coverage issue is an intentional governance action:
      // materialize its remediation chain once before the evidence bundle switches
      // to read-only aggregation for all subsequent scoped lookups.
      remediation = this.remediation.list({ ...timeFilter, sourceType: 'coverage', status: 'all', issueId: explicitIssueId, limit: 20 }).items.find((item) => item.sourceId === explicitIssueId);
    }
    let alert = explicitAlertId ? this.alerting.list({ ...timeFilter, alertId: explicitAlertId, status: 'all', limit: 1 }).items[0] : undefined;
    if (!alert && auditAlertId) alert = this.alerting.list({ ...timeFilter, alertId: auditAlertId, status: 'all', limit: 1 }).items[0];
    if (!alert && notificationDelivery?.alertId) alert = this.alerting.list({ ...timeFilter, alertId: notificationDelivery.alertId, status: 'all', limit: 1 }).items[0];
    if (!alert && remediation?.alertId) alert = this.alerting.list({ ...timeFilter, alertId: remediation.alertId, status: 'all', limit: 1 }).items[0];
    if (!alert && explicitIssueId) {
      alert = this.alerting.list({ ...timeFilter, kind: 'coverage', status: 'all', issueId: explicitIssueId, limit: 20 }).items.find((item) => item.labels?.issueId === explicitIssueId);
    }

    const relatedIssueId = explicitIssueId ?? auditIssueId ?? notificationDelivery?.issueId ?? alert?.labels?.issueId ?? (remediation?.sourceType === 'coverage' ? remediation.sourceId : undefined);
    const coverageIssue = relatedIssueId
      ? this.agg.coverageOverview({ ...timeFilter, issueId: relatedIssueId, limit: 1 }).issues.find((item) => item.issueId === relatedIssueId)
      : undefined;

    let incident = explicitIncidentId ? this.agg.incidents({ ...timeFilter, incidentId: explicitIncidentId, status: 'all', limit: 1 }).items[0] : undefined;
    const relatedIncidentId = explicitIncidentId ?? auditIncidentId ?? notificationDelivery?.incidentId ?? alert?.incidentId ?? remediation?.incidentId;
    if (!incident && relatedIncidentId) incident = this.agg.incidents({ ...timeFilter, incidentId: relatedIncidentId, status: 'all', limit: 1 }).items[0];

    const relatedEventId = explicitEventId ?? topologyEdge?.sampleEventId ?? auditEventId ?? notificationDelivery?.eventId ?? alert?.eventId ?? remediation?.eventId ?? coverageIssue?.evidenceEventId ?? incident?.lastEventId;
    let event = relatedEventId
      ? (await readStoredEvents({
          ...timeFilter,
          eventId: relatedEventId,
          subjectAssetId: explicitSubjectAssetId,
          limit: 1,
        })).items[0]
      : undefined;
    if (!event && query.traceId) {
      event = (await readStoredEvents({
        ...timeFilter,
        traceId: selector(query.traceId, 240),
        subjectAssetId: explicitSubjectAssetId,
        limit: 1,
      })).items[0];
    }

    const relatedObjectiveId = explicitObjectiveId ?? auditObjectiveId ?? notificationDelivery?.objectiveId ?? alertObjectiveId(alert) ?? remediationObjectiveId(remediation);
    let objective = relatedObjectiveId ? this.objectives.list({ ...timeFilter, objectiveId: relatedObjectiveId, limit: 1 }, { observe: false }).items[0] : undefined;
    const explicitWorkspacePath = selector(query.workspacePath);
    const explicitAgentId = selector(query.agentId, 240);
    const explicitCollectorId = selector(query.collectorId, 180);
    const explicitSourceId = selector(query.sourceId, 180);
    const explicitTraceId = selector(query.traceId, 240);
    const explicitRunId = selector(query.runId, 240);
    const explicitSessionId = selector(query.sessionId, 240);
    const maintenanceAgentScope = maintenanceWindow?.targetType === 'agent' ? splitAgentTargetId(maintenanceWindow.targetId) : {};
    const objectiveAgentScope = objective?.targetType === 'agent' ? splitAgentTargetId(objective.targetId) : {};
    const agentWorkspaceScope = explicitWorkspacePath ?? maintenanceAgentScope.workspacePath ?? objectiveAgentScope.workspacePath;
    const relatedAgentId = prefer(
      explicitAgentId,
      auditAgentId,
      notificationDelivery?.agentId,
      maintenanceAgentScope.agentId,
      event?.agentId,
      incident?.agentId,
      alert?.agentId,
      remediation?.agentId,
      coverageIssue?.agentId,
      objectiveAgentScope.agentId,
    );
    const relatedSourceId = prefer(
      explicitSourceId,
      auditSourceId,
      notificationDelivery?.sourceId,
      maintenanceTarget(maintenanceWindow, 'source'),
      evidenceEventSourceId(event),
      incident?.sourceId,
      alert?.sourceId,
      remediation?.ingestionSourceId,
      coverageIssue?.sourceId,
      objectiveTarget(objective, 'source'),
    );
    const scopedSource = relatedSourceId
      ? this.sources.list({ sourceId: relatedSourceId, limit: 1 }).items.find((item) => item.sourceId === relatedSourceId)
      : undefined;
    const agentMetadataCandidates = relatedAgentId
      ? this.agentMetadata.list().filter((item) => item.agentId === relatedAgentId && (!agentWorkspaceScope || item.workspacePath === agentWorkspaceScope))
      : [];
    const scopedAgentMetadata = agentMetadataCandidates.length === 1 ? agentMetadataCandidates[0] : undefined;

    const scope: T.EvidenceBundleScope = {
      primaryType,
      primaryId,
      auditId: prefer(explicitAuditId, auditRecord?.auditId),
      edgeId: prefer(explicitEdgeId, topologyEdge?.edgeId),
      eventId: prefer(explicitEventId, auditEventId, notificationDelivery?.eventId, event?.eventId, alert?.eventId, remediation?.eventId, incident?.lastEventId),
      incidentId: prefer(explicitIncidentId, auditIncidentId, notificationDelivery?.incidentId, incident?.incidentId, alert?.incidentId, remediation?.incidentId),
      alertId: prefer(explicitAlertId, auditAlertId, notificationDelivery?.alertId, alert?.alertId, remediation?.alertId),
      taskId: prefer(explicitTaskId, auditTaskId, notificationDelivery?.taskId, remediation?.taskId),
      objectiveId: prefer(explicitObjectiveId, auditObjectiveId, notificationDelivery?.objectiveId, objective?.objectiveId, alertObjectiveId(alert), remediationObjectiveId(remediation)),
      issueId: prefer(explicitIssueId, auditIssueId, notificationDelivery?.issueId, coverageIssue?.issueId, alert?.labels?.issueId, remediation?.sourceType === 'coverage' ? remediation.sourceId : undefined),
      deliveryId: prefer(explicitDeliveryId, auditDeliveryId, notificationDelivery?.deliveryId),
      windowId: prefer(explicitWindowId, auditWindowId, maintenanceWindow?.windowId),
      workspacePath: prefer(explicitWorkspacePath, auditWorkspacePath, notificationDelivery?.workspacePath, maintenanceTarget(maintenanceWindow, 'workspace'), maintenanceAgentScope.workspacePath, event?.workspacePath, incident?.workspacePath, alert?.workspacePath, remediation?.workspacePath, coverageIssue?.workspacePath, scopedSource?.workspacePath, scopedAgentMetadata?.workspacePath, objectiveAgentScope.workspacePath, objectiveTarget(objective, 'workspace')),
      agentId: relatedAgentId,
      subjectAssetId: explicitSubjectAssetId,
      collectorId: prefer(explicitCollectorId, auditCollectorId, notificationDelivery?.collectorId, maintenanceTarget(maintenanceWindow, 'collector'), evidenceEventCollectorId(event), incident?.collectorId, alert?.collectorId, remediation?.collectorId, coverageIssue?.collectorId, scopedSource?.collectorId, objectiveTarget(objective, 'collector')),
      sourceId: relatedSourceId,
      traceId: prefer(explicitTraceId, event?.traceId, incident?.traceId, alert?.traceId, remediation?.traceId),
      runId: prefer(explicitRunId, event?.runId, incident?.runId, alert?.runId),
      sessionId: prefer(explicitSessionId, event?.sessionId, incident?.sessionId, alert?.sessionId),
    };

    const makeEventFilter = (): T.AgentEventQuery => ({
      ...timeFilter,
      eventId: scope.eventId,
      sourceId: scope.sourceId,
      collectorId: scope.collectorId,
      agentId: scope.agentId,
      subjectAssetId: scope.subjectAssetId,
      sessionId: scope.sessionId,
      workspacePath: scope.workspacePath,
      traceId: scope.traceId,
      runId: scope.runId,
      limit,
    });
    let eventFilter = makeEventFilter();
    let eventList = await readStoredEvents(eventFilter);
    const initialEvent = event;
    const listedPrimaryEvent = scope.eventId ? eventList.items.find((item) => item.eventId === scope.eventId) : undefined;
    if (listedPrimaryEvent) {
      event = listedPrimaryEvent;
      if (!explicitWorkspacePath && (!scope.workspacePath || scope.workspacePath === initialEvent?.workspacePath)) {
        scope.workspacePath = listedPrimaryEvent.workspacePath;
      }
      if (!explicitAgentId && (!scope.agentId || scope.agentId === initialEvent?.agentId)) {
        scope.agentId = listedPrimaryEvent.agentId;
      }
      if (!explicitCollectorId && (!scope.collectorId || scope.collectorId === evidenceEventCollectorId(initialEvent))) {
        scope.collectorId = evidenceEventCollectorId(listedPrimaryEvent) ?? scope.collectorId;
      }
      if (!explicitSourceId && (!scope.sourceId || scope.sourceId === evidenceEventSourceId(initialEvent))) {
        scope.sourceId = evidenceEventSourceId(listedPrimaryEvent) ?? scope.sourceId;
      }
      if (!explicitTraceId && (!scope.traceId || scope.traceId === initialEvent?.traceId)) {
        scope.traceId = listedPrimaryEvent.traceId;
      }
      if (!explicitRunId && (!scope.runId || scope.runId === initialEvent?.runId)) {
        scope.runId = listedPrimaryEvent.runId;
      }
      if (!explicitSessionId && (!scope.sessionId || scope.sessionId === initialEvent?.sessionId)) {
        scope.sessionId = listedPrimaryEvent.sessionId;
      }
      eventFilter = makeEventFilter();
      eventList = await readStoredEvents(eventFilter);
      event = eventList.items.find((item) => item.eventId === listedPrimaryEvent.eventId) ?? listedPrimaryEvent;
    }
    const storedTimeline = await readStoredTimeline({ ...eventFilter, limit: Math.max(limit, 120) });
    const subjectScoped = Boolean(scope.subjectAssetId);
    const durableEvidenceCoverage = conservativeEvidenceCoverage(eventList.coverage, storedTimeline.coverage);
    // EvidenceBundle does not duplicate QueryCoverage at the top level. Make its timeline coverage
    // conservatively represent both durable reads, so a ClickHouse fallback/scan bound can never be
    // hidden merely because the other read happened to be complete.
    const timeline: T.AgentTimeline = {
      ...storedTimeline,
      coverage: subjectScoped
        ? {
            ...durableEvidenceCoverage,
            // Non-event Evidence stores do not yet all expose subjectAssetId indexes. Their
            // direct-parent filtering below is safe but bounded, so the bundle must not claim exact
            // whole-window completeness for those auxiliary facts.
            partial: true,
            partialReason: durableEvidenceCoverage.partialReason ?? 'scan_limit',
            completeness: 'partial',
            totalMode: 'estimated',
          }
        : durableEvidenceCoverage,
    };
    const subjectEventIds = new Set(eventList.items.map((item) => item.eventId));
    const subjectWorkspacePaths = new Set(eventList.items.map((item) => item.workspacePath).filter(Boolean));
    const subjectSourceIds = new Set(eventList.items.map((item) => evidenceEventSourceId(item)).filter((item): item is string => Boolean(item)));
    const subjectCollectorIds = new Set(eventList.items.map((item) => evidenceEventCollectorId(item)).filter((item): item is string => Boolean(item)));
    const exactEventContext = Boolean(
      scope.eventId ||
        scope.subjectAssetId ||
        scope.auditId ||
        scope.edgeId ||
        scope.incidentId ||
        scope.alertId ||
        scope.taskId ||
        scope.objectiveId ||
        scope.issueId ||
        scope.deliveryId ||
        scope.windowId ||
        scope.workspacePath ||
        scope.agentId ||
        scope.collectorId ||
        scope.sourceId ||
        scope.traceId ||
        scope.runId ||
        scope.sessionId,
    );
    const scopedAgentIds = new Set<string>();
    const scopedAgentKeys = new Set<string>();
    const addScopedAgent = (workspacePath: string | undefined, agentId: string | undefined) => {
      if (!agentId) return;
      scopedAgentIds.add(agentId);
      if (workspacePath) scopedAgentKeys.add(`${workspacePath}:${agentId}`);
    };
    addScopedAgent(scope.workspacePath, scope.agentId);
    if (exactEventContext) {
      for (const item of eventList.items) addScopedAgent(item.workspacePath, item.agentId);
    }
    const incidentCandidates = this.agg.incidents({
      ...timeFilter,
      incidentId: scope.incidentId,
      status: 'all',
      sourceId: scope.sourceId,
      collectorId: scope.collectorId,
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      workspacePath: scope.workspacePath,
      traceId: scope.traceId,
      limit,
    });
    const incidentItems = subjectScoped
      ? incidentCandidates.items.filter((item) => subjectEventIds.has(item.lastEventId))
      : incidentCandidates.items;
    const incidentSummary: Record<T.IncidentStatus, number> = { open: 0, acknowledged: 0, resolved: 0 };
    for (const item of incidentItems) incidentSummary[item.status] += 1;
    const incidents: T.IncidentList = {
      ...incidentCandidates,
      items: incidentItems,
      total: incidentItems.length,
      summary: incidentSummary,
    };
    const subjectIncidentIds = new Set(incidentItems.map((item) => item.incidentId));
    const alertCandidates = this.alerting.list({
      ...timeFilter,
      alertId: scope.alertId,
      status: 'all',
      kind: scope.issueId && !scope.alertId ? 'coverage' : undefined,
      issueId: scope.issueId,
      incidentId: scope.incidentId,
      eventId: scope.eventId,
      taskId: scope.taskId,
      objectiveId: scope.objectiveId,
      sourceId: scope.sourceId,
      collectorId: scope.collectorId,
      agentId: scope.agentId,
      workspacePath: scope.workspacePath,
      limit,
    });
    const alertItemsForScope = subjectScoped
      ? alertCandidates.items.filter((item) =>
          Boolean(item.eventId && subjectEventIds.has(item.eventId))
          || Boolean(item.incidentId && subjectIncidentIds.has(item.incidentId)))
      : alertCandidates.items;
    const alerts = { ...alertCandidates, items: alertItemsForScope, total: alertItemsForScope.length };
    const alertItems = new Map<string, T.AlertListItem>();
    for (const item of alerts.items) alertItems.set(item.alertId, item);
    const subjectAlertIds = new Set(alerts.items.map((item) => item.alertId));

    const relatedObjectiveIds = new Set<string>();
    const addObjectiveId = (id: string | undefined) => {
      if (id) relatedObjectiveIds.add(id);
    };
    addObjectiveId(scope.objectiveId);
    for (const item of alerts.items) addObjectiveId(alertObjectiveId(item));

    const remediationCandidates = this.remediation.list({
      ...timeFilter,
      taskId: scope.taskId,
      status: 'all',
      sourceType: scope.issueId ? 'coverage' : undefined,
      incidentId: scope.incidentId,
      alertId: scope.alertId,
      eventId: scope.eventId,
      objectiveId: scope.objectiveId,
      issueId: scope.issueId,
      sourceId: scope.sourceId,
      collectorId: scope.collectorId,
      agentId: scope.agentId,
      workspacePath: scope.workspacePath,
      limit,
    }, { refresh: false });
    const remediationItemsForScope = subjectScoped
      ? remediationCandidates.items.filter((item) =>
          Boolean(item.eventId && subjectEventIds.has(item.eventId))
          || Boolean(item.incidentId && subjectIncidentIds.has(item.incidentId))
          || Boolean(item.alertId && subjectAlertIds.has(item.alertId)))
      : remediationCandidates.items;
    const remediations = {
      ...remediationCandidates,
      items: remediationItemsForScope,
      total: remediationItemsForScope.length,
    };
    const remediationItems = new Map<string, T.RemediationListItem>();
    for (const item of remediations.items) {
      remediationItems.set(item.taskId, item);
      addObjectiveId(remediationObjectiveId(item));
    }
    if (!objective && relatedObjectiveIds.size > 0) {
      const [firstObjectiveId] = [...relatedObjectiveIds];
      objective = this.objectives.list({ ...timeFilter, objectiveId: firstObjectiveId, limit: 1 }, { observe: false }).items[0];
    }
    const objectiveCandidateMap = new Map<string, T.ObjectiveItem>();
    const addObjectiveCandidates = (query: T.ObjectiveQuery) => {
      for (const item of this.objectives.list({ ...timeFilter, ...query, limit: 500 }, { observe: false }).items) {
        if (relatedObjectiveIds.has(item.objectiveId) || objectiveMatchesScope(item, scope)) {
          objectiveCandidateMap.set(item.objectiveId, item);
        }
      }
    };
    for (const objectiveId of relatedObjectiveIds) addObjectiveCandidates({ objectiveId });
    if (scope.workspacePath) addObjectiveCandidates({ targetType: 'workspace', targetId: scope.workspacePath });
    if (scope.agentId) addObjectiveCandidates({ targetType: 'agent' });
    if (scope.collectorId) addObjectiveCandidates({ targetType: 'collector', targetId: scope.collectorId });
    if (scope.sourceId) addObjectiveCandidates({ targetType: 'source', targetId: scope.sourceId });
    if (scope.primaryType === 'scope' && !scope.workspacePath && !scope.agentId && !scope.collectorId && !scope.sourceId) {
      addObjectiveCandidates({ targetType: 'global' });
    }
    const objectiveCandidates = [...objectiveCandidateMap.values()];
    if (objective) objectiveCandidates.unshift(objective);
    const objectiveItems = new Map<string, T.ObjectiveItem>();
    for (const item of objectiveCandidates) {
      objectiveItems.set(item.objectiveId, item);
      addObjectiveId(item.objectiveId);
    }
    for (const objectiveId of relatedObjectiveIds) {
      const objectiveAlerts = this.alerting.list({ ...timeFilter, status: 'all', kind: 'objective', objectiveId, limit }).items;
      for (const item of objectiveAlerts) {
        if (
          !subjectScoped
          || Boolean(item.eventId && subjectEventIds.has(item.eventId))
          || Boolean(item.incidentId && subjectIncidentIds.has(item.incidentId))
        ) alertItems.set(item.alertId, item);
      }
    }
    for (const item of alertItems.values()) {
      if (item.kind !== 'objective') continue;
      const objectiveId = alertObjectiveId(item);
      addObjectiveId(objectiveId);
      if (objectiveId && !objectiveItems.has(objectiveId)) {
        const found = this.objectives.list({ ...timeFilter, objectiveId, limit: 1 }, { observe: false }).items[0];
        if (found) objectiveItems.set(found.objectiveId, found);
      }
      for (const task of this.remediation.list({ ...timeFilter, status: 'all', sourceType: 'alert', alertId: item.alertId, limit: 20 }, { refresh: false }).items) {
        remediationItems.set(task.taskId, task);
      }
    }
    const coverageCandidates = this.agg.coverageOverview({
      ...timeFilter,
      issueId: scope.issueId,
      sourceId: scope.sourceId,
      collectorId: scope.collectorId,
      agentId: scope.agentId,
      workspacePath: scope.workspacePath,
      limit,
    });
    const coverageIssues = subjectScoped
      ? coverageCandidates.issues.filter((item) =>
          Boolean(item.evidenceEventId && subjectEventIds.has(item.evidenceEventId)))
      : coverageCandidates.issues;
    const coverage = { ...coverageCandidates, issues: coverageIssues };
    const coverageIssueIds = new Set(coverage.issues.map((item) => item.issueId));
    if (coverageIssueIds.size > 0) {
      this.alerting.observeCoverageList(coverage.issues, Date.now(), { resolveMissing: false });
      for (const issueId of coverageIssueIds) {
        for (const item of this.alerting.list({ ...timeFilter, status: 'all', kind: 'coverage', issueId, limit: 20 }).items) {
          alertItems.set(item.alertId, item);
        }
        for (const item of this.remediation.list({ ...timeFilter, status: 'all', sourceType: 'coverage', issueId, limit: 20 }, { refresh: false }).items) {
          remediationItems.set(item.taskId, item);
          addObjectiveId(remediationObjectiveId(item));
        }
      }
      if (!alert && scope.issueId) alert = [...alertItems.values()].find((item) => item.kind === 'coverage' && item.labels?.issueId === scope.issueId);
      if (!remediation && scope.issueId) {
        remediation = [...remediationItems.values()].find((item) => item.sourceType === 'coverage' && (item.sourceId === scope.issueId || item.labels?.issueId === scope.issueId));
      }
      scope.alertId = prefer(scope.alertId, alert?.alertId);
      scope.taskId = prefer(scope.taskId, remediation?.taskId);
    }
    const bundleAlerts = sortByDateDesc([...alertItems.values()], (item) => item.lastSeenAt).slice(0, limit);
    const bundleRemediations = sortByDateDesc([...remediationItems.values()], (item) => item.updatedAt).slice(0, limit);
    const subjectRelatedObjectiveIds = new Set<string>([
      ...bundleAlerts.map((item) => alertObjectiveId(item)).filter((item): item is string => Boolean(item)),
      ...bundleRemediations.map((item) => remediationObjectiveId(item)).filter((item): item is string => Boolean(item)),
    ]);
    const bundleObjectives = sortByDateDesc(
      [...objectiveItems.values()].filter((item) => !subjectScoped || subjectRelatedObjectiveIds.has(item.objectiveId)),
      (item) => item.evaluatedAt,
    ).slice(0, limit);
    const subjectBundleAlertIds = new Set(bundleAlerts.map((item) => item.alertId));
    const subjectRemediationIds = new Set(bundleRemediations.map((item) => item.taskId));
    const subjectObjectiveIds = new Set(bundleObjectives.map((item) => item.objectiveId));
    const notificationDeliveryItems = new Map<string, T.NotificationDeliveryItem>();
    const addNotificationDeliveries = (filter: T.NotificationConfigQuery) => {
      if (!notificationConfigQueryHasSelector(filter)) return;
      for (const item of this.notifications.config({ ...filter, limit: Math.min(300, limit) }).deliveries) {
        notificationDeliveryItems.set(item.deliveryId, item);
      }
    };
    if (notificationDelivery) notificationDeliveryItems.set(notificationDelivery.deliveryId, notificationDelivery);
    addNotificationDeliveries({ deliveryId: scope.deliveryId });
    addNotificationDeliveries({ alertId: scope.alertId });
    addNotificationDeliveries({ incidentId: scope.incidentId });
    addNotificationDeliveries({ eventId: scope.eventId });
    addNotificationDeliveries({ taskId: scope.taskId });
    addNotificationDeliveries({ objectiveId: scope.objectiveId });
    addNotificationDeliveries({ issueId: scope.issueId });
    if (alert?.alertId) addNotificationDeliveries({ alertId: alert.alertId });
    for (const item of incidents.items) {
      addNotificationDeliveries({ incidentId: item.incidentId });
      addNotificationDeliveries({ eventId: item.lastEventId });
    }
    for (const item of bundleAlerts) {
      addNotificationDeliveries({ alertId: item.alertId });
      addNotificationDeliveries({ incidentId: item.incidentId });
      addNotificationDeliveries({ eventId: item.eventId });
      addNotificationDeliveries({ taskId: item.labels?.taskId });
      addNotificationDeliveries({ objectiveId: item.labels?.objectiveId });
      addNotificationDeliveries({ issueId: item.labels?.issueId });
    }
    for (const item of bundleRemediations) {
      addNotificationDeliveries({ taskId: item.taskId });
      addNotificationDeliveries({ incidentId: item.incidentId });
      addNotificationDeliveries({ eventId: item.eventId });
      addNotificationDeliveries({ objectiveId: remediationObjectiveId(item) });
      addNotificationDeliveries({ issueId: item.labels?.issueId ?? (item.sourceType === 'coverage' ? item.sourceId : undefined) });
    }
    for (const item of bundleObjectives) addNotificationDeliveries({ objectiveId: item.objectiveId });
    for (const item of coverage.issues) addNotificationDeliveries({ issueId: item.issueId });
    addNotificationDeliveries({
      sourceId: scope.sourceId,
      collectorId: scope.collectorId,
      agentId: scope.agentId,
      workspacePath: scope.workspacePath,
    });
    const notificationDeliveryCandidates = sortByDateDesc(
      [...notificationDeliveryItems.values()].filter((item) =>
        !subjectScoped
        || Boolean(item.eventId && subjectEventIds.has(item.eventId))
        || Boolean(item.incidentId && subjectIncidentIds.has(item.incidentId))
        || Boolean(item.alertId && subjectBundleAlertIds.has(item.alertId))
        || Boolean(item.taskId && subjectRemediationIds.has(item.taskId))
        || Boolean(item.objectiveId && subjectObjectiveIds.has(item.objectiveId))
        || Boolean(item.issueId && coverageIssueIds.has(item.issueId))),
      (item) => item.sentAt,
    );
    const pinnedNotificationDeliveries = notificationDeliveryCandidates.filter((item) => notificationDeliveryMatchesScope(item, scope));
    const relatedNotificationDeliveries = notificationDeliveryCandidates.filter((item) => !notificationDeliveryMatchesScope(item, scope));
    const notificationDeliveries = [...pinnedNotificationDeliveries, ...relatedNotificationDeliveries].slice(0, limit);
    const maintenanceItems = new Map<string, T.MaintenanceWindowItem>();
    const addMaintenanceWindows = (filter: T.MaintenanceWindowQuery, predicate: (item: T.MaintenanceWindowItem) => boolean = () => true) => {
      const hasSelector = Boolean(filter.windowId || filter.targetId || (filter.targetType && filter.targetType !== 'all'));
      if (!hasSelector && filter.status !== 'active') return;
      for (const item of this.maintenance.list({ ...timeFilter, ...filter, limit: Math.min(300, limit) }).items) {
        if (predicate(item)) maintenanceItems.set(item.windowId, item);
      }
    };
    if (maintenanceWindow) maintenanceItems.set(maintenanceWindow.windowId, maintenanceWindow);
    addMaintenanceWindows({ windowId: scope.windowId, status: 'all' });
    for (const item of coverage.issues) addMaintenanceWindows({ windowId: item.maintenanceWindowId, status: 'all' });
    if (scope.sourceId) addMaintenanceWindows({ targetType: 'source', targetId: scope.sourceId, status: 'all' });
    if (scope.collectorId) addMaintenanceWindows({ targetType: 'collector', targetId: scope.collectorId, status: 'all' });
    if (scope.workspacePath) addMaintenanceWindows({ targetType: 'workspace', targetId: scope.workspacePath, status: 'all' });
    if (scope.agentId) {
      addMaintenanceWindows({ targetType: 'agent', targetId: scope.agentId, status: 'all' });
      if (scope.workspacePath) addMaintenanceWindows({ targetType: 'agent', targetId: `${scope.workspacePath}:${scope.agentId}`, status: 'all' });
    }
    if (exactEventContext) {
      for (const agentId of scopedAgentIds) addMaintenanceWindows({ targetType: 'agent', targetId: agentId, status: 'all' });
      for (const agentKey of scopedAgentKeys) addMaintenanceWindows({ targetType: 'agent', targetId: agentKey, status: 'all' });
    }
    addMaintenanceWindows({ status: 'active' }, (item) => item.targetType === 'all');
    const maintenanceWindows = sortByDateDesc([...maintenanceItems.values()].filter((item) =>
      maintenanceWindowMatchesScope(item, scope, { agentIds: scopedAgentIds, agentKeys: scopedAgentKeys })
      && (
        !subjectScoped
        || item.targetType === 'all'
        || (item.targetType === 'workspace' && subjectWorkspacePaths.has(item.targetId))
        || (item.targetType === 'agent' && (scopedAgentIds.has(item.targetId) || scopedAgentKeys.has(item.targetId)))
        || (item.targetType === 'source' && subjectSourceIds.has(item.targetId))
        || (item.targetType === 'collector' && subjectCollectorIds.has(item.targetId))
      )), (item) => item.updatedAt).slice(0, limit);
    const topologyCandidates = this.agg.agentTopology({
      ...timeFilter,
      edgeId: scope.edgeId,
      eventId: scope.eventId,
      sourceId: scope.sourceId,
      collectorId: scope.collectorId,
      agentId: scope.agentId,
      workspacePath: scope.workspacePath,
      includeBenign: true,
      limit,
    });
    const topologyEdges = subjectScoped
      ? topologyCandidates.edges.filter((edge) => subjectEventIds.has(edge.sampleEventId))
      : topologyCandidates.edges;
    const topologyNodeIds = new Set(topologyEdges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]));
    const topologyNodes = subjectScoped
      ? topologyCandidates.nodes.filter((node) => topologyNodeIds.has(node.nodeId))
      : topologyCandidates.nodes;
    const topology: T.AgentTopology = {
      ...topologyCandidates,
      nodes: topologyNodes,
      edges: topologyEdges,
      summary: {
        agentCount: topologyNodes.filter((node) => node.type === 'agent').length,
        workspaceCount: topologyNodes.filter((node) => node.type === 'workspace').length,
        collectorCount: topologyNodes.filter((node) => node.type === 'collector').length,
        toolTargetCount: topologyNodes.filter((node) => node.type === 'tool').length,
        externalEndpointCount: topologyNodes.filter((node) => node.type === 'network').length,
        fileTargetCount: topologyNodes.filter((node) => node.type === 'file').length,
        llmEndpointCount: topologyNodes.filter((node) => node.type === 'llm').length,
        securityTargetCount: topologyNodes.filter((node) => node.type === 'security').length,
        nodeCount: topologyNodes.length,
        edgeCount: topologyEdges.length,
        riskyEdgeCount: topologyEdges.filter((edge) => edge.riskyEventCount > 0).length,
      },
    };
    const sourceQuery: T.IngestionSourceQuery | undefined = scope.sourceId
      ? { sourceId: scope.sourceId, limit: 10 }
      : scope.collectorId
        ? { collectorId: scope.collectorId, limit: 10 }
        : scope.workspacePath
          ? { workspacePath: scope.workspacePath, limit: 10 }
          : undefined;
    const sourceItems = new Map<string, T.IngestionSourceItem>();
    if (sourceQuery) {
      for (const item of this.sources.list(sourceQuery).items) sourceItems.set(item.sourceId, item);
    }
    if (subjectScoped) {
      for (const subjectEvent of eventList.items) {
        const sourceId = evidenceEventSourceId(subjectEvent);
        if (!sourceId || sourceItems.has(sourceId)) continue;
        const item = this.sources.list({ sourceId, limit: 1 }).items.find((candidate) => candidate.sourceId === sourceId);
        if (item) sourceItems.set(item.sourceId, item);
      }
    }
    const sources = [...sourceItems.values()].slice(0, limit);
    const collectorItems = new Map<string, T.CollectorHealthItem>();
    const addCollector = (collectorId: string | undefined) => {
      if (!collectorId || collectorItems.has(collectorId)) return;
      const item = this.agg.collectorHealth({ ...timeFilter, collectorId, limit: 1 }).items.find((candidate) => candidate.collectorId === collectorId);
      if (item) collectorItems.set(item.collectorId, item);
    };
    addCollector(scope.collectorId);
    for (const item of sources) addCollector(item.collectorId);
    if (subjectScoped) {
      for (const subjectEvent of eventList.items) addCollector(evidenceEventCollectorId(subjectEvent));
    }
    const collectors = [...collectorItems.values()].slice(0, limit);
    const agentItems = new Map<string, T.AgentInventoryItem>();
    const addAgentItem = (item: T.AgentInventoryItem) => agentItems.set(item.agentAssetId, item);
    const addAgent = (workspacePath: string | undefined, agentId: string | undefined, agentAssetId?: string) => {
      if (!workspacePath || !agentId || (agentAssetId && agentItems.has(agentAssetId))) return;
      const item = this.agg.agentInventory({
        ...timeFilter,
        agentId,
        agentAssetId,
        workspacePath,
        includeUnclassified: true,
        limit: 1,
      }).items.find((candidate) =>
        agentAssetId
          ? candidate.agentAssetId === agentAssetId
          : candidate.agentId === agentId && candidate.workspacePath === workspacePath,
      );
      if (item) addAgentItem(item);
    };
    if (scope.agentId) {
      for (const item of this.agg.agentInventory({
        ...timeFilter,
        agentId: scope.agentId,
        workspacePath: scope.workspacePath,
        includeUnclassified: true,
        limit,
      }).items) addAgentItem(item);
    } else if (scope.workspacePath && !scope.sourceId && !scope.collectorId) {
      for (const item of this.agg.agentInventory({ ...timeFilter, workspacePath: scope.workspacePath, limit }).items) addAgentItem(item);
    }
    for (const item of eventList.items) addAgent(item.workspacePath, item.agentId, item.agentAssetId);
    const agents = [...agentItems.values()].slice(0, limit);
    const workspaceItems = new Map<string, T.WorkspaceInventoryItem>();
    const addWorkspace = (workspacePath: string | undefined) => {
      if (!workspacePath || workspaceItems.has(workspacePath)) return;
      const item = this.agg.workspaceInventory({ ...timeFilter, workspacePath, limit: 1 }).items.find((candidate) => candidate.workspacePath === workspacePath);
      if (item) workspaceItems.set(item.workspacePath, item);
    };
    addWorkspace(scope.workspacePath);
    if (subjectScoped) {
      for (const subjectEvent of eventList.items) addWorkspace(subjectEvent.workspacePath);
    }
    for (const item of agents) addWorkspace(item.workspacePath);
    for (const item of sources) addWorkspace(item.workspacePath);
    const workspaces = [...workspaceItems.values()].slice(0, limit);

    const auditItems = new Map<string, T.AuditListItem>();
    if (auditRecord) auditItems.set(auditRecord.auditId, auditRecord);
    const addAudit = (resourceType: T.AuditResourceType, resourceId: string | undefined) => {
      if (!resourceId) return;
      for (const item of this.audit.list({ ...timeFilter, resourceType, resourceId, limit: 30 }).items) auditItems.set(item.auditId, item);
    };
    addAudit('incident', scope.incidentId);
    for (const item of incidents.items) addAudit('incident', item.incidentId);
    addAudit('alert', scope.alertId);
    for (const item of bundleAlerts) addAudit('alert', item.alertId);
    addAudit('remediation', scope.taskId);
    for (const item of bundleRemediations) addAudit('remediation', item.taskId);
    addAudit('objective', scope.objectiveId);
    for (const item of bundleObjectives) addAudit('objective', item.objectiveId);
    for (const item of notificationDeliveries) addAudit('notification', item.deliveryId);
    for (const item of maintenanceWindows) addAudit('maintenance', item.windowId);
    addAudit('source', scope.sourceId);
    for (const item of sources) addAudit('source', item.sourceId);
    addAudit('agent', scope.workspacePath && scope.agentId ? `${scope.workspacePath}:${scope.agentId}` : undefined);
    for (const item of agents) {
      addAudit('agent', item.agentAssetId);
      // Compatibility for audit records written before Agent assets gained a stable ID.
      addAudit('agent', `${item.workspacePath}:${item.agentId}`);
    }
    const relatedAuditResources = new Set<string>([
      ...incidents.items.map((item) => `incident\0${item.incidentId}`),
      ...bundleAlerts.map((item) => `alert\0${item.alertId}`),
      ...bundleRemediations.map((item) => `remediation\0${item.taskId}`),
      ...bundleObjectives.map((item) => `objective\0${item.objectiveId}`),
      ...notificationDeliveries.map((item) => `notification\0${item.deliveryId}`),
      ...maintenanceWindows.map((item) => `maintenance\0${item.windowId}`),
      ...sources.map((item) => `source\0${item.sourceId}`),
      ...agents.flatMap((item) => [`agent\0${item.agentAssetId}`, `agent\0${item.workspacePath}:${item.agentId}`]),
    ]);
    const audits = [...auditItems.values()]
      .filter((item) =>
        !subjectScoped
        || Boolean(auditDetailText(item, 'eventId') && subjectEventIds.has(auditDetailText(item, 'eventId')!))
        || relatedAuditResources.has(`${item.resourceType}\0${item.resourceId}`))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, limit);

    const primaryIncident = subjectScoped
      ? incidents.items.find((item) => item.incidentId === incident?.incidentId)
      : incident;
    const primaryAlert = subjectScoped
      ? bundleAlerts.find((item) => item.alertId === alert?.alertId)
      : alert;
    const primaryRemediation = subjectScoped
      ? bundleRemediations.find((item) => item.taskId === remediation?.taskId)
      : remediation;
    const primaryObjective = subjectScoped
      ? bundleObjectives.find((item) => item.objectiveId === objective?.objectiveId)
      : objective;
    const primaryCoverageIssue = subjectScoped
      ? coverage.issues.find((item) => item.issueId === coverageIssue?.issueId)
      : coverageIssue;
    const primaryNotification = subjectScoped
      ? notificationDeliveries.find((item) => item.deliveryId === notificationDelivery?.deliveryId)
      : notificationDelivery;
    const primaryMaintenance = subjectScoped
      ? maintenanceWindows.find((item) => item.windowId === maintenanceWindow?.windowId)
      : maintenanceWindow;
    const primaryAudit = subjectScoped
      ? audits.find((item) => item.auditId === auditRecord?.auditId)
      : auditRecord;
    const primaryTopologyEdge = subjectScoped
      ? topology.edges.find((item) => item.edgeId === topologyEdge?.edgeId)
      : topologyEdge;
    if (subjectScoped) {
      if (scope.eventId && !subjectEventIds.has(scope.eventId)) scope.eventId = undefined;
      if (scope.incidentId && !subjectIncidentIds.has(scope.incidentId)) scope.incidentId = undefined;
      if (scope.alertId && !subjectBundleAlertIds.has(scope.alertId)) scope.alertId = undefined;
      if (scope.taskId && !subjectRemediationIds.has(scope.taskId)) scope.taskId = undefined;
      if (scope.objectiveId && !subjectObjectiveIds.has(scope.objectiveId)) scope.objectiveId = undefined;
      if (scope.issueId && !coverageIssueIds.has(scope.issueId)) scope.issueId = undefined;
      if (scope.deliveryId && !notificationDeliveries.some((item) => item.deliveryId === scope.deliveryId)) scope.deliveryId = undefined;
      if (scope.windowId && !maintenanceWindows.some((item) => item.windowId === scope.windowId)) scope.windowId = undefined;
      if (scope.edgeId && !topology.edges.some((item) => item.edgeId === scope.edgeId)) scope.edgeId = undefined;
      if (scope.auditId && !audits.some((item) => item.auditId === scope.auditId)) scope.auditId = undefined;
    }
    const primary = {
      ...(event ? { event } : {}),
      ...(primaryIncident ? { incident: primaryIncident } : {}),
      ...(primaryAlert ? { alert: primaryAlert } : {}),
      ...(primaryRemediation ? { remediation: primaryRemediation } : {}),
      ...(primaryObjective ? { objective: primaryObjective } : {}),
      ...(primaryCoverageIssue ? { coverageIssue: primaryCoverageIssue } : {}),
      ...(primaryNotification ? { notificationDelivery: primaryNotification } : {}),
      ...(primaryMaintenance ? { maintenanceWindow: primaryMaintenance } : {}),
      ...(primaryAudit ? { audit: primaryAudit } : {}),
      ...(primaryTopologyEdge ? { topologyEdge: primaryTopologyEdge } : {}),
    };
    return {
      schemaVersion: 'anysentry.evidence_bundle.v1',
      bundleId: bundleId(scope),
      generatedAt: new Date().toISOString(),
      classificationView: eventList.classificationView,
      reviewRevision: eventList.reviewRevision,
      assetBindingRevision: this.observedAssets.bindingRevision(),
      scope,
      summary: {
        eventCount: eventList.total,
        incidentCount: incidents.total,
        alertCount: bundleAlerts.length,
        remediationCount: bundleRemediations.length,
        objectiveCount: bundleObjectives.length,
        notificationDeliveryCount: notificationDeliveries.length,
        maintenanceWindowCount: maintenanceWindows.length,
        coverageIssueCount: coverage.issues.length,
        topologyNodeCount: topology.nodes.length,
        topologyEdgeCount: topology.edges.length,
        auditCount: audits.length,
        agentCount: agents.length,
        workspaceCount: workspaces.length,
        sourceCount: sources.length,
        collectorCount: collectors.length,
        maxSeverity: maxSeverity(...eventList.items, ...incidents.items, ...bundleAlerts, ...bundleRemediations, ...bundleObjectives, ...coverage.issues),
        riskCategories: riskCategories(eventList.items),
      },
      primary,
      timeline,
      events: eventList.items,
      incidents: incidents.items,
      alerts: bundleAlerts,
      remediations: bundleRemediations,
      objectives: bundleObjectives,
      notificationDeliveries,
      maintenanceWindows,
      coverageIssues: coverage.issues,
      topology,
      agents,
      workspaces,
      sources,
      collectors,
      audits,
    };
  }

  @Post('evidence/export')
  @HttpCode(200)
  async evidenceExport(@Body() query: T.EvidenceBundleExportQuery = {}): Promise<T.EvidenceBundleExport> {
    const bundle = await this.evidenceBundle(query);
    const format: T.EvidenceBundleExportFormat = query.format ?? 'markdown';
    const content = evidenceMarkdown(bundle);
    return {
      schemaVersion: 'anysentry.evidence_export.v1',
      bundleId: bundle.bundleId,
      generatedAt: new Date().toISOString(),
      format,
      contentType: 'text/markdown; charset=utf-8',
      filename: `${bundle.bundleId}.md`,
      contentSha256: createHash('sha256').update(content).digest('hex'),
      scope: bundle.scope,
      summary: bundle.summary,
      classificationView: bundle.classificationView,
      reviewRevision: bundle.reviewRevision,
      assetBindingRevision: bundle.assetBindingRevision,
      content,
    };
  }

  /** Live agent-observability stream (a frame every 3s), consumed by the dashboard's SSE client. */
  @Sse('sessions/agentObservability/stream')
  @SkipWrap()
  stream(@Query() q: T.SecurityTimeFilter): Observable<{ data: T.AgentObservability }> {
    // A slow durable read must never stack another full-window query behind itself. Every result
    // still covers the complete requested window as of its own snapshot, so coalescing timer ticks
    // drops duplicate work rather than events or query dimensions.
    return timer(0, 3000).pipe(
      exhaustMap(async () => ({ data: await this.agg.sharedAgentObservabilityForWindow(q) })),
    );
  }

  /** The editable judge policy (L1 rules / L2 LLM / L3 a3s-code) + which tiers are active. The
   *  config panels read this; the dashboard only enables tiers whose model API is callable. */
  @Get('config')
  async getConfig() {
    await this.runtimeModels.refreshConnectivity();
    return { ...this.judge.getPolicy(), connections: this.runtimeModels.statuses() };
  }

  /** Apply + persist a new policy: rebuilds the sentry ACL and recreates the judge in place. */
  @Put('config')
  @RequireManagementAuth()
  async setConfig(@Body() body: unknown, @Headers() headers: HeaderBag) {
    let updated: Awaited<ReturnType<SentryJudgeService['setPolicy']>>;
    try {
      updated = await this.judge.setPolicy(body);
    } catch (error) {
      throw policyBadRequest(error);
    }
    const fast = this.runtimeModels.get('fast_review');
    const deep = this.runtimeModels.get('deep_investigation');
    // A policy document may intentionally carry the runtime-managed placeholder while immutable
    // deployment credentials come from the environment. Only a UI-applied runtime connection is
    // owned by this endpoint and may be invalidated by a policy edit; clearing an environment
    // snapshot here makes the documented "apply policy after rollout" sequence disable L2/L3
    // until the API is restarted.
    if (fast?.source === 'runtime' && (
      !updated.policy.llm || fast.url !== updated.policy.llm.url || fast.model !== updated.policy.llm.model
    )) {
      await this.runtimeModels.clear('fast_review');
    }
    if (deep?.source === 'runtime' && (
      !updated.policy.deepModel || deep.url !== updated.policy.deepModel.url || deep.model !== updated.policy.deepModel.model
    )) {
      await this.runtimeModels.clear('deep_investigation');
    }
    this.audit.record({
      actor: auditActor(headers),
      action: 'policy.updated',
      resourceType: 'policy',
      resourceId: 'default',
      summary: 'Policy updated',
      details: {
        failClosed: updated.policy.failClosed,
        speculate: updated.policy.speculate,
        ruleCount: updated.policy.rules.length,
        llmConfigured: Boolean(updated.policy.llm),
        agentConfigured: Boolean(updated.policy.agent),
        status: updated.status,
      },
    });
    await this.runtimeModels.refreshConnectivity();
    return { policy: updated.policy, status: this.judge.getPolicy().status, connections: this.runtimeModels.statuses() };
  }

  @Get('config/model-connections')
  @RequireManagementAuth()
  async modelConnectionStatus() {
    await this.runtimeModels.refreshConnectivity();
    return this.runtimeModels.statuses();
  }

  /** Test one exact connection through the same in-process A3S Code SDK used by judgment. The key
   *  remains in API memory and the response contains only a short-lived opaque apply token. */
  @Post('config/model-connections/test')
  @RequireManagementAuth()
  @HttpCode(200)
  async testModelConnection(@Body() body: unknown) {
    const input = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const profile = input.profile === 'fast_review' || input.profile === 'deep_investigation'
      ? input.profile
      : undefined;
    if (!profile) throw new BadRequestException('profile must be fast_review or deep_investigation');
    let connection;
    try {
      connection = sanitizeRuntimeModelConnection({
        url: typeof input.url === 'string' ? input.url : '',
        model: typeof input.model === 'string' ? input.model : '',
        apiKey: typeof input.apiKey === 'string' ? input.apiKey : '',
        timeoutS: Number(input.timeoutS),
        contextTokens: Number(input.contextTokens),
      }, profile);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const result = profile === 'fast_review'
      ? await testFastReviewConnection(connection)
      : await testDeepInvestigationConnection(
          connection,
          this.judge.getPolicy().policy.agent?.skills || process.env.ANYSENTRY_L3_SKILLS || '/opt/anysentry/skills',
        );
    if (!result.ok) return result;
    return { ...result, ...this.runtimeModels.rememberSuccessfulTest(profile, connection) };
  }

  @Put('config/model-connections/:profile')
  @RequireManagementAuth()
  async applyModelConnection(
    @Param('profile') profileText: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ) {
    const profile = this.modelProfile(profileText);
    const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const testToken = typeof input.testToken === 'string' ? input.testToken : '';
    let snapshot;
    try {
      const connection = this.runtimeModels.consumeSuccessfulTest(profile, testToken);
      const current = this.judge.getPolicy().policy;
      await this.judge.setPolicy(profile === 'fast_review'
        ? { ...current, llm: { url: connection.url, model: connection.model, timeoutS: connection.timeoutS } }
        : {
            ...current,
            deepModel: {
              url: connection.url,
              model: connection.model,
              timeoutS: connection.timeoutS,
              contextTokens: connection.contextTokens,
            },
          });
      snapshot = await this.runtimeModels.activate(profile, connection);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    this.audit.record({
      actor: auditActor(headers),
      action: 'policy.updated',
      resourceType: 'policy',
      resourceId: profile,
      summary: `${profile === 'fast_review' ? 'Fast review' : 'Deep investigation'} model connection applied`,
      details: { profile, endpoint: snapshot.url, model: snapshot.model, source: snapshot.source },
    });
    return { ...this.judge.getPolicy(), connections: this.runtimeModels.statuses() };
  }

  @Post('config/model-connections/:profile/clear')
  @RequireManagementAuth()
  @HttpCode(200)
  async clearModelConnection(@Param('profile') profileText: string, @Headers() headers: HeaderBag) {
    const profile = this.modelProfile(profileText);
    await this.runtimeModels.clear(profile);
    this.audit.record({
      actor: auditActor(headers),
      action: 'policy.updated',
      resourceType: 'policy',
      resourceId: profile,
      summary: `${profile === 'fast_review' ? 'Fast review' : 'Deep investigation'} runtime credential cleared`,
      details: { profile },
    });
    return { ...this.judge.getPolicy(), connections: this.runtimeModels.statuses() };
  }

  @Post('config/simulate')
  @RequireManagementAuth()
  @HttpCode(200)
  async simulateConfig(@Body() body: T.PolicySimulationRequest, @Headers() headers: HeaderBag) {
    let result: T.PolicySimulationResult;
    try {
      result = await this.agg.storedPolicySimulation(body);
    } catch (error) {
      throw policyBadRequest(error);
    }
    this.audit.record({
      actor: auditActor(headers),
      action: 'policy.simulated',
      resourceType: 'policy',
      resourceId: 'default',
      summary: `Policy simulation changed ${result.summary.changedEvents}/${result.summary.evaluatedEvents} events`,
      details: {
        timeType: body.timeType,
        limit: body.limit,
        sampleLimit: result.sampling.sampleLimit,
        sampledEvents: result.sampling.sampledEvents,
        truncated: result.sampling.truncated,
        evaluatedEvents: result.summary.evaluatedEvents,
        changedEvents: result.summary.changedEvents,
        newBlocks: result.summary.newBlocks,
        removedBlocks: result.summary.removedBlocks,
        newEscalations: result.summary.newEscalations,
        affectedAgents: result.summary.affectedAgents,
        affectedWorkspaces: result.summary.affectedWorkspaces,
      },
    });
    return result;
  }

  /** Store histograms — which signal kinds / verdicts / tiers are flowing (ops + verification). */
  @Get('stats')
  stats() {
    return this.judge.stats();
  }

  /**
   * Canonical raw-fact metadata endpoint.  It never returns captured body bytes; callers receive
   * hash/ref/length and provenance only.  The endpoint is management-authenticated because even
   * opaque source and process identifiers can reveal tenant/runtime topology.
   */
  @Get('v1/raw-observations')
  @RequireManagementAuth()
  async canonicalRawObservations(@Query('limit') limit?: string) {
    const bounded = boundedCanonicalStoreLimit(limit);
    const result = await this.boundedCanonicalList(
      this.canonicalObservability.listDurable(bounded),
      () => this.canonicalObservability.raw.list(bounded),
    );
    const reasons = result.degraded ? ['canonical_raw_observation_projection_unavailable'] : [];
    const dataSource = result.degraded ? 'memory_hot_ring' : 'canonical_raw_observation_store';
    return {
      schemaVersion: 'anysentry.raw_observation.list.v1',
      items: result.items,
      total: result.items.length,
      store: this.canonicalObservability.stats(),
      coverage: canonicalCoverage(result.degraded, reasons, dataSource),
      dataSource,
      updateTime: new Date().toISOString(),
    };
  }

  @Get('v1/raw-observations/:observationId')
  @RequireManagementAuth()
  async canonicalRawObservation(@Param('observationId') observationId: string, @Query('revision') revisionText?: string) {
    const id = strictIdentityText(observationId, 240);
    if (!id) throw new BadRequestException('observationId is invalid');
    const revision = revisionText === undefined ? undefined : Number(revisionText);
    if (revisionText !== undefined && (revision === undefined || !Number.isSafeInteger(revision) || revision < 1)) {
      throw new BadRequestException('revision is invalid');
    }
    const result = await this.boundedCanonicalPoint(
      this.canonicalObservability.getDurableRawObservation(id, revision),
      () => this.canonicalObservability.raw.get(id, revision),
    );
    if (!result.value) {
      if (result.degraded) throw new ServiceUnavailableException('Canonical raw observation projection is unavailable');
      throw new NotFoundException('raw observation not found');
    }
    return {
      schemaVersion: 'anysentry.raw_observation.v1',
      item: result.value,
      coverage: canonicalCoverage(
        result.degraded,
        result.degraded ? ['canonical_raw_observation_projection_unavailable'] : [],
        result.degraded ? 'memory_hot_ring' : 'canonical_raw_observation_store',
      ),
      dataSource: result.degraded ? 'memory_hot_ring' : 'canonical_raw_observation_store',
    };
  }

  /** Coverage is a first-class projection: parser/adapter/TLS gaps never erase Kernel facts. */
  @Get('v1/coverage-gaps')
  @RequireManagementAuth()
  canonicalCoverageGaps(@Query('limit') limit?: string) {
    const bounded = boundedCanonicalStoreLimit(limit);
    const items = this.canonicalObservability.listGaps(bounded);
    return {
      schemaVersion: 'anysentry.coverage_gap.list.v1',
      items,
      total: items.length,
      gapStore: this.canonicalObservability.gapStats(),
      updateTime: new Date().toISOString(),
    };
  }

  /**
   * Read a canonical side-lane collection without allowing a slow durable sink to block the
   * request.  The hot store is append-only and bounded, so it is a safe compatibility fallback;
   * callers must expose `degraded` as partial coverage instead of presenting it as a complete
   * historical read.
   */
  private async boundedCanonicalList<T>(
    operation: Promise<T[]>,
    hot: () => T[],
  ): Promise<{ items: T[]; degraded: boolean }> {
    let degraded = this.relational.configured() && !this.relational.isReady();
    try {
      const items = await withCanonicalProjectionTimeout(
        operation,
        CANONICAL_STORE_READ_TIMEOUT_MS,
      );
      return { items, degraded };
    } catch (error) {
      if (!isCanonicalProjectionDegradation(error)) throw error;
      degraded = true;
      return { items: hot(), degraded };
    }
  }

  /**
   * Point reads use the same durable-first ordering as list reads, but consult the hot immutable
   * store immediately when the durable side lane times out.  `degraded` remains distinct from
   * a genuine missing ID so callers can return 503 rather than a misleading 404.
   */
  private async boundedCanonicalPoint<T>(
    operation: Promise<T | undefined>,
    hot: () => T | undefined,
  ): Promise<{ value?: T; degraded: boolean }> {
    let degraded = this.relational.configured() && !this.relational.isReady();
    try {
      const value = await withCanonicalProjectionTimeout(
        operation,
        CANONICAL_STORE_READ_TIMEOUT_MS,
      );
      if (value !== undefined) return { value, degraded };
    } catch (error) {
      if (!isCanonicalProjectionDegradation(error)) throw error;
      degraded = true;
    }
    const value = hot();
    return { value, degraded: degraded || value !== undefined };
  }

  /**
   * Resolve a KernelFact from the canonical side lane first, then from its immutable compatibility
   * event. The fallback is metadata-only and explicitly marked partial; it exists for the period
   * in which PostgreSQL persistence is degraded, so a ToolExec event never exposes a dead 404
   * deep link merely because its derived side row arrived late.
   */
  private async canonicalKernelFactWithFallback(
    factId: string,
  ): Promise<{ fact: KernelFact; fallback: boolean }> {
    const canonical = await this.boundedCanonicalPoint(
      this.canonicalObservability.getDurableKernelFact(factId),
      () => this.canonicalObservability.kernel.get(factId),
    );
    if (canonical.value) return { fact: canonical.value, fallback: canonical.degraded };
    let unavailable = canonical.degraded;
    // New events are indexed by a forward-only ClickHouse MV. Resolve the stable KernelFact ID to
    // its compatibility event first, then perform an eventId point read; this avoids a wide
    // time-window JSON scan for facts written after the locator table was introduced. A missing
    // locator is expected for pre-migration rows and falls through to the bounded legacy query.
    try {
      const locator = await withCanonicalProjectionTimeout(
        this.judge.loadKernelFactLocator(factId),
        CANONICAL_STORE_READ_TIMEOUT_MS,
      );
      if (locator) {
        const event = await withCanonicalProjectionTimeout(
          this.judge.storedEventById(locator.eventId, locator.at),
          CANONICAL_STORE_READ_TIMEOUT_MS,
        );
        if (event?.kernelFactId === factId) {
          const reconstructed = kernelFactFromCompatibilityEvent(event, factId);
          if (reconstructed) return { fact: reconstructed, fallback: true };
        }
      }
    } catch (error) {
      if (!isCanonicalProjectionDegradation(error)) throw error;
      unavailable = true;
    }
    try {
      const page = await withCanonicalProjectionTimeout(
        this.judge.searchStoredEventsPage({
          // Compatibility events are retained longer than the canonical hot KernelFact lane, but
          // this recovery query must stay narrow so a degraded deep link cannot scan the whole
          // 90-day MergeTree. Operators can widen the bounded window explicitly when auditing an
          // older fact.
          sinceMs: Math.max(0, Date.now() - CANONICAL_KERNEL_FALLBACK_LOOKBACK_MS),
          untilMs: Date.now(),
          kernelFactId: factId,
          candidateLimit: 8,
          limit: 1,
        }),
        CANONICAL_STORE_READ_TIMEOUT_MS,
      );
      if (page.unavailable) {
        // In the intentional memory-only profile there is no durable compatibility backend to
        // consult, so an absent hot fact is a real 404. Treat an unavailable page as transient
        // only when a configured durable backend exists.
        unavailable = this.relational.configured() || this.judge.storageStatus().clickhouseConfigured;
      } else {
        const event = page.events.find((candidate) => candidate.kernelFactId === factId);
        const reconstructed = event ? kernelFactFromCompatibilityEvent(event, factId) : undefined;
        if (reconstructed) return { fact: reconstructed, fallback: true };
      }
    } catch (error) {
      if (!isCanonicalProjectionDegradation(error)) throw error;
      unavailable = true;
    }
    if (unavailable) {
      throw new ServiceUnavailableException('Canonical kernel fact projection is unavailable');
    }
    throw new NotFoundException('kernel fact not found');
  }

  /** Machine-side canonical facts remain queryable even when no semantic Adapter is available. */
  @Get('v1/kernel-facts')
  @RequireManagementAuth()
  async canonicalKernelFacts(@Query('limit') limit?: string) {
    const bounded = boundedCanonicalStoreLimit(limit);
    const result = await this.boundedCanonicalList(
      this.canonicalObservability.listDurableKernelFacts(bounded),
      () => this.canonicalObservability.kernelFacts(bounded),
    );
    const reasons = result.degraded ? ['canonical_kernel_fact_projection_unavailable'] : [];
    const dataSource = result.degraded ? 'memory_hot_ring' : 'canonical_kernel_fact_store';
    return {
      schemaVersion: 'anysentry.kernel_fact.list.v1',
      items: result.items,
      total: result.items.length,
      store: this.canonicalObservability.kernelStats(),
      coverage: canonicalCoverage(result.degraded, reasons, dataSource),
      dataSource,
      updateTime: new Date().toISOString(),
    };
  }

  @Get('v1/kernel-facts/:factId')
  @RequireManagementAuth()
  async canonicalKernelFact(@Param('factId') factId: string) {
    const id = strictIdentityText(factId, 240);
    if (!id) throw new BadRequestException('factId is invalid');
    const resolved = await this.canonicalKernelFactWithFallback(id);
    return {
      schemaVersion: 'anysentry.kernel_fact.v1',
      item: resolved.fact,
      coverage: canonicalCoverage(
        resolved.fallback,
        resolved.fallback ? ['canonical_kernel_fact_projection_unavailable'] : [],
        resolved.fallback ? 'compatibility_event_projection' : 'canonical_kernel_fact_store',
      ),
      dataSource: resolved.fallback ? 'compatibility_event_projection' : 'canonical_kernel_fact_store',
    };
  }

  /** Rebuildable human-side semantic projection; bodies remain hash/ref-only in this lane. */
  @Get('v1/semantic-records')
  @RequireManagementAuth()
  async canonicalSemanticRecords(@Query('limit') limit?: string) {
    const bounded = boundedCanonicalStoreLimit(limit);
    const result = await this.boundedCanonicalList(
      this.canonicalObservability.listDurableSemanticRecords(bounded),
      () => this.canonicalObservability.semantic.list(bounded),
    );
    const reasons = result.degraded ? ['canonical_semantic_record_projection_unavailable'] : [];
    const dataSource = result.degraded ? 'memory_hot_ring' : 'canonical_semantic_record_store';
    return {
      schemaVersion: 'anysentry.semantic_record.list.v1',
      items: result.items,
      total: result.items.length,
      store: this.canonicalObservability.semanticStats(),
      coverage: canonicalCoverage(result.degraded, reasons, dataSource),
      dataSource,
      updateTime: new Date().toISOString(),
    };
  }

  @Get('v1/semantic-records/:semanticRecordId')
  @RequireManagementAuth()
  async canonicalSemanticRecord(@Param('semanticRecordId') semanticRecordId: string, @Query('revision') revisionText?: string) {
    const id = strictIdentityText(semanticRecordId, 240);
    if (!id) throw new BadRequestException('semanticRecordId is invalid');
    const revision = revisionText === undefined ? undefined : Number(revisionText);
    if (revisionText !== undefined && (revision === undefined || !Number.isSafeInteger(revision) || revision < 1)) {
      throw new BadRequestException('revision is invalid');
    }
    const result = await this.boundedCanonicalPoint(
      this.canonicalObservability.getDurableSemanticRecord(id, revision),
      () => this.canonicalObservability.semantic.get(id, revision),
    );
    if (!result.value) {
      if (result.degraded) throw new ServiceUnavailableException('Canonical semantic record projection is unavailable');
      throw new NotFoundException('semantic record not found');
    }
    return {
      schemaVersion: 'anysentry.semantic_record.v1',
      item: result.value,
      coverage: canonicalCoverage(
        result.degraded,
        result.degraded ? ['canonical_semantic_record_projection_unavailable'] : [],
        result.degraded ? 'memory_hot_ring' : 'canonical_semantic_record_store',
      ),
      dataSource: result.degraded ? 'memory_hot_ring' : 'canonical_semantic_record_store',
    };
  }

  @Get('v1/evidence-links')
  @RequireManagementAuth()
  async canonicalEvidenceLinks(@Query('limit') limit?: string) {
    const bounded = boundedCanonicalStoreLimit(limit);
    const result = await this.boundedCanonicalList(
      this.canonicalObservability.listDurableEvidenceLinks(bounded),
      () => this.canonicalObservability.evidence.list(bounded),
    );
    const reasons = result.degraded ? ['canonical_evidence_link_projection_unavailable'] : [];
    const dataSource = result.degraded ? 'memory_hot_ring' : 'canonical_evidence_link_store';
    return {
      schemaVersion: 'anysentry.evidence_link.list.v1',
      items: result.items,
      total: result.items.length,
      store: this.canonicalObservability.evidence.stats(),
      coverage: canonicalCoverage(result.degraded, reasons, dataSource),
      dataSource,
      updateTime: new Date().toISOString(),
    };
  }

  @Get('v1/evidence-links/:linkId')
  @RequireManagementAuth()
  async canonicalEvidenceLink(@Param('linkId') linkId: string, @Query('resolutionRevision') revisionText?: string) {
    const id = strictIdentityText(linkId, 240);
    if (!id) throw new BadRequestException('linkId is invalid');
    const revision = revisionText === undefined ? undefined : Number(revisionText);
    if (revisionText !== undefined && (revision === undefined || !Number.isSafeInteger(revision) || revision < 1)) {
      throw new BadRequestException('resolutionRevision is invalid');
    }
    const result = await this.boundedCanonicalPoint(
      this.canonicalObservability.getDurableEvidenceLink(id, revision),
      () => this.canonicalObservability.evidence.get(id, revision),
    );
    if (!result.value) {
      if (result.degraded) throw new ServiceUnavailableException('Canonical evidence link projection is unavailable');
      throw new NotFoundException('evidence link not found');
    }
    return {
      schemaVersion: 'anysentry.evidence_link.v1',
      item: result.value,
      coverage: canonicalCoverage(
        result.degraded,
        result.degraded ? ['canonical_evidence_link_projection_unavailable'] : [],
        result.degraded ? 'memory_hot_ring' : 'canonical_evidence_link_store',
      ),
      dataSource: result.degraded ? 'memory_hot_ring' : 'canonical_evidence_link_store',
    };
  }

  @Get('v1/session-memberships')
  @RequireManagementAuth()
  async canonicalSessionMemberships(@Query('limit') limit?: string) {
    const bounded = boundedCanonicalStoreLimit(limit);
    const result = await this.boundedCanonicalList(
      this.canonicalObservability.listDurableSessionMemberships(bounded),
      () => this.canonicalObservability.sessionMemberships.list(bounded),
    );
    const reasons = result.degraded ? ['canonical_session_membership_projection_unavailable'] : [];
    const dataSource = result.degraded ? 'memory_hot_ring' : 'canonical_session_membership_store';
    return {
      schemaVersion: 'anysentry.session_membership.list.v1',
      items: result.items,
      total: result.items.length,
      store: this.canonicalObservability.sessionMembershipStats(),
      coverage: canonicalCoverage(result.degraded, reasons, dataSource),
      dataSource,
      updateTime: new Date().toISOString(),
    };
  }

  @Get('v1/session-memberships/:membershipId')
  @RequireManagementAuth()
  async canonicalSessionMembership(@Param('membershipId') membershipId: string, @Query('resolutionRevision') revisionText?: string) {
    const id = strictIdentityText(membershipId, 240);
    if (!id) throw new BadRequestException('membershipId is invalid');
    const revision = revisionText === undefined ? undefined : Number(revisionText);
    if (revisionText !== undefined && (revision === undefined || !Number.isSafeInteger(revision) || revision < 1)) {
      throw new BadRequestException('resolutionRevision is invalid');
    }
    const result = await this.boundedCanonicalPoint(
      this.canonicalObservability.getDurableSessionMembership(id, revision),
      () => this.canonicalObservability.sessionMemberships.get(id, revision),
    );
    if (!result.value) {
      if (result.degraded) throw new ServiceUnavailableException('Canonical session membership projection is unavailable');
      throw new NotFoundException('session membership not found');
    }
    return {
      schemaVersion: 'anysentry.session_membership.v1',
      item: result.value,
      coverage: canonicalCoverage(
        result.degraded,
        result.degraded ? ['canonical_session_membership_projection_unavailable'] : [],
        result.degraded ? 'memory_hot_ring' : 'canonical_session_membership_store',
      ),
      dataSource: result.degraded ? 'memory_hot_ring' : 'canonical_session_membership_store',
    };
  }

  /**
   * The fact endpoints above intentionally expose only append-only records.  These four resource
   * endpoints are the missing entity/read-model seam: they project the existing directory/runtime
   * stores without reparsing payloads or writing a binding as a side effect of a GET.
   */
  private canonicalCurrentRevision(): number {
    return Math.max(
      1,
      this.agg.agentConversationResolutionRevision(),
      this.agentMetadata.identitySnapshotVersion(),
    );
  }

  private canonicalConversationDirectoryQuery(
    query: CanonicalEntityQuery,
  ): T.AgentConversationDirectoryQuery {
    return {
      timeType: query.timeType,
      startTime: query.startTime,
      endTime: query.endTime,
      snapshotAsOf: query.snapshotAsOf,
      scope: 'agent',
      classificationView: query.classificationView,
      agentAssetId: query.agentAssetId,
      // Canonical entity IDs are post-projection filters. Keeping an AgentInstance predicate here
      // would make a cache entry for one detail page unusable for sibling resources.
      agentInstanceId: undefined,
      product: query.product,
      q: query.q,
      lifecycleScope: query.lifecycleScope,
      // Entity resources hydrate RuntimeInstance independently.  Keeping runtime-only rows out of
      // this compatibility projection prevents a 5k-instance history from becoming thousands of
      // repeated LogicalAgent records before the canonical page filter is applied.
      includeRuntimeOnly: false,
      // The compatibility projector still needs a bounded semantic sample for conversation
      // counts/coverage.  It is deliberately smaller than the legacy 200-row dashboard page;
      // RuntimeState and SessionMembership remain the authoritative fallback lanes.
      limit: Math.min(64, Math.max(1, query.limit + query.offset + 16)),
    };
  }

  private async canonicalDirectorySnapshot(
    query: CanonicalEntityQuery,
    headers: HeaderBag,
  ): Promise<T.AgentConversationDirectoryListV4> {
    // The V4 compatibility projection is already read-only and carries userThreads, recent
    // runtime records, and coverage.  Reuse it rather than introducing a second aggregation path.
    this.pruneCanonicalDirectoryCache();
    const key = this.canonicalDirectoryCacheKey(query, headers);
    const cached = this.canonicalDirectoryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      // The projection is treated as immutable by all canonical resource builders. Returning the
      // cached object avoids another large structured clone on every nested read; JSON response
      // serialization itself does not mutate it.
      this.canonicalDirectoryCache.delete(key);
      this.canonicalDirectoryCache.set(key, cached);
      return cached.value;
    }
    const inFlight = this.canonicalDirectoryInFlight.get(key);
    if (inFlight) return inFlight;
    if (this.canonicalDirectoryInFlight.size >= CANONICAL_DIRECTORY_INFLIGHT_MAX) {
      throw new ServiceUnavailableException('Canonical directory projection is busy; retry the latest selection');
    }
    const operation = this.agentConversationDirectoryV4(
      this.canonicalConversationDirectoryQuery(query),
      headers,
    )
      .then((value) => {
        this.rememberCanonicalDirectorySnapshot(key, value);
        return value;
      })
      .finally(() => {
        if (this.canonicalDirectoryInFlight.get(key) === operation) {
          this.canonicalDirectoryInFlight.delete(key);
        }
      });
    this.canonicalDirectoryInFlight.set(key, operation);
    // The full directory projection may need a broad ClickHouse/relational read.  A deep link
    // must still return a bounded, explicit partial result when that secondary read is stalled;
    // runtime/entity builders can continue from their own bounded in-memory state.  Promise.race
    // attaches rejection handlers to the underlying operation, so a late database failure cannot
    // become an unhandled rejection; the normal finally above still removes the in-flight entry.
    return withCanonicalProjectionTimeout(operation, CANONICAL_DIRECTORY_PROJECTION_TIMEOUT_MS)
      .catch((error) => {
        if (!isCanonicalProjectionDegradation(error)) throw error;
        this.canonicalDirectoryCacheDropped += 1;
        const fallback = this.degradedCanonicalDirectorySnapshot(query, 'directory_projection_timeout');
        // Do not leave a timed-out Promise as the next caller's in-flight value.  Cache the
        // bounded fallback for the same short TTL so rapid UI navigation does not fan out more
        // stalled database reads while the original operation finishes in the background.
        if (this.canonicalDirectoryInFlight.get(key) === operation) {
          this.canonicalDirectoryInFlight.delete(key);
        }
        this.rememberCanonicalDirectorySnapshot(key, fallback);
        return fallback;
      });
  }

  private degradedCanonicalDirectorySnapshot(
    query: CanonicalEntityQuery,
    reason: string,
  ): T.AgentConversationDirectoryListV4 {
    const now = new Date().toISOString();
    const coverage: T.QueryCoverage = {
      requestedFrom: now,
      requestedTo: now,
      snapshotAsOf: now,
      asOf: now,
      partial: true,
      partialReason: reason === 'directory_projection_timeout' ? 'projection_timeout' : 'storage_unavailable',
      source: 'memory_hot_ring',
      totalMode: 'omitted',
    };
    return {
      apiVersion: 4,
      resolutionRevision: this.canonicalCurrentRevision(),
      items: [],
      runningCount: 0,
      historicalCount: 0,
      total: 0,
      totalMode: 'omitted',
      classificationView: query.classificationView ?? 'current_effective',
      reviewRevision: this.agentMetadata.identitySnapshotVersion(),
      coverage,
      dataSource: 'hot_ring',
      updateTime: now,
      // Keep the timeout reason in the bounded data-source label without copying backend error
      // text or credentials into the response.
    };
  }

  private canonicalRevisionCoverage(
    query: CanonicalEntityQuery,
    revision: number,
    base: T.CanonicalEntityCoverage,
  ): T.CanonicalEntityCoverage {
    if (query.revision === undefined || query.revision === revision) return base;
    return {
      ...base,
      status: 'partial',
      reasons: [...new Set([...base.reasons, 'requested_revision_not_available'])].slice(0, 64),
    };
  }

  private async canonicalLogicalAgentResources(
    query: CanonicalEntityQuery,
    headers: HeaderBag,
  ): Promise<{
    items: T.CanonicalLogicalAgentResource[];
    coverage: T.CanonicalEntityCoverage;
    dataSource: string;
    revision: number;
  }> {
    const directory = await this.canonicalDirectorySnapshot(query, headers);
    // RuntimeState.list() performs lifecycle pruning, canonical de-duplication and a bounded
    // clone of the selected page.  Calling it once per directory item turns a page read into
    // O(directoryItems × history) work (and repeatedly clones thousands of historical records).
    // Take one immutable snapshot for this request and only filter that snapshot below.
    const runtimeSnapshot = this.agentRuntimeState.list({
      agentInstanceId: undefined,
      sourceId: query.sourceId,
      includeShadow: true,
      limit: CANONICAL_RUNTIME_STATE_READ_LIMIT,
    }).items;
    const runtimeByIdentity = new Map<string, T.AgentRuntimeInstanceRecord>();
    for (const record of runtimeSnapshot) {
      for (const identity of [
        record.agentInstanceId,
        record.canonicalAgentInstanceId,
        ...(record.agentInstanceAliases ?? []),
      ].filter((value): value is string => Boolean(value))) {
        runtimeByIdentity.set(identity, record);
      }
    }
    // The canonical compatibility snapshot intentionally omits runtime-only rows.  Rebuild those
    // rows locally from the same RuntimeState snapshot so an unknown/candidate agent remains
    // discoverable without reintroducing the expensive broad conversation projection.
    const conversationLogicalIds = new Set(directory.items.map((item) => item.logicalAgentId));
    const runtimeOnlyDirectory = projectAgentConversationDirectory([], runtimeSnapshot, query.lifecycleScope)
      .filter((item) => !conversationLogicalIds.has(item.logicalAgentId));
    const directoryItems: T.LogicalAgentConversationDirectoryItemV4[] = [
      ...directory.items,
      ...runtimeOnlyDirectory.map((item) => ({
        ...item,
        userThreads: [] as T.AgentConversationSummary[],
        recentInstances: [] as T.AgentRuntimeDirectoryInstance[],
        technicalActivities: [] as T.AgentRunTechnicalActivitySummary[],
        technicalActivityCount: 0,
        instanceCounts: {
          active: item.lifecycleState === 'running' ? item.activeInstanceCount : 0,
          idle: 0,
          unobserved: item.lifecycleState === 'unobserved' ? item.activeInstanceCount : 0,
          exited: item.lifecycleState === 'historical' ? item.totalInstanceCount : 0,
          lost: 0,
          total: item.totalInstanceCount,
        },
        conversationCounts: { active: 0, dormant: 0, incomplete: 0, total: 0 },
      })),
    ];
    const resources = directoryItems
      .filter((item) => {
        const conversations = item.userThreads ?? [];
        const runtimeIds = [...new Set([
          ...item.agentInstanceIds,
          ...item.recentInstances.flatMap((instance) => [
          instance.agentInstanceId,
          instance.canonicalAgentInstanceId,
          ...(instance.agentInstanceAliases ?? []),
          ]),
        ])];
        const sessionIds = conversations.flatMap((conversation) => [
          conversation.conversationId,
          conversation.sessionId,
          conversation.canonicalParentSessionId,
        ].filter((value): value is string => Boolean(value)));
        const classifications = conversations.map((conversation) => conversation.classification);
        const classification = classifications.includes('confirmed_agent')
          ? 'confirmed_agent'
          : classifications.includes('probable_agent') ? 'probable_agent' : undefined;
        return canonicalScopeMatches({
          logicalAgentId: item.logicalAgentId,
          logicalAgentCandidateId: item.candidateId,
          logicalDefinitionId: item.logicalDefinitionId,
          tenantId: item.tenantId,
          ownerId: item.ownerId,
          workspacePath: item.workspacePath,
          environment: item.environment,
          environmentId: item.environmentId,
          agentAssetId: item.agentAssetIds[0],
          agentInstanceId: query.agentInstanceId && runtimeIds.includes(query.agentInstanceId)
            ? query.agentInstanceId : undefined,
          runtimeInstanceId: query.runtimeInstanceId && runtimeIds.includes(query.runtimeInstanceId)
            ? query.runtimeInstanceId : undefined,
          sessionId: query.sessionId && sessionIds.includes(query.sessionId) ? query.sessionId : undefined,
          product: item.product,
          classification,
          coverageStatus: item.coverage.status,
          q: [item.displayName, item.product, item.workspacePath, ...sessionIds].join(' '),
        }, {
          ...query,
          // The helper performs equality on optional fields; a requested ID which is not present
          // must reject this item instead of turning into an undefined wildcard.
          ...(query.agentInstanceId && !runtimeIds.includes(query.agentInstanceId)
            ? { agentInstanceId: '__missing__' } : {}),
          ...(query.runtimeInstanceId && !runtimeIds.includes(query.runtimeInstanceId)
            ? { runtimeInstanceId: '__missing__' } : {}),
          ...(query.sessionId && !sessionIds.includes(query.sessionId)
            ? { sessionId: '__missing__' } : {}),
        });
      })
      .map((item): T.CanonicalLogicalAgentResource => {
        const conversations = item.userThreads ?? [];
        const sessionIds = [...new Set(conversations.flatMap((conversation) => [
          conversation.sessionId,
          conversation.conversationId,
        ].filter((value): value is string => Boolean(value))))].slice(0, 512);
        const identityQuality = item.groupingQuality === 'exact'
          ? 'confirmed'
          : item.groupingQuality;
        const sourceRefs = [
          `logical-agent-directory:${item.logicalAgentId}`,
          ...item.agentInstanceIds.slice(0, 32).map((id) => `agent-instance:${id}`),
        ];
        // Runtime state is the authoritative source/collector provenance for an AgentInstance;
        // the legacy directory itself intentionally has no producer-controlled source fields.
        const runtimeRecords = [...new Set(item.agentInstanceIds
          .flatMap((id) => {
            const record = runtimeByIdentity.get(id);
            return record ? [record] : [];
          }))];
        const collectorIds = [...new Set(runtimeRecords.map((record) => record.collectorId))].slice(0, 64);
        const sourceIds = [...new Set(runtimeRecords
          .map((record) => record.sourceId)
          .filter((value): value is string => Boolean(value)))].slice(0, 64);
        return {
          schemaVersion: 'anysentry.logical_agent.v1',
          logicalAgentId: item.logicalAgentId,
          ...(item.candidateId ? { logicalAgentCandidateId: item.candidateId } : {}),
          ...(item.logicalDefinitionId ? { logicalDefinitionId: item.logicalDefinitionId } : {}),
          ...(item.logicalScopeMode ? { logicalScopeMode: item.logicalScopeMode } : {}),
          ...(item.logicalIdentityAuthority ? { logicalIdentityAuthority: item.logicalIdentityAuthority } : {}),
          ...(item.definitionFingerprint ? { definitionFingerprint: item.definitionFingerprint } : {}),
          identityQuality,
          family: item.product,
          product: item.product,
          displayName: item.displayName,
          ...(item.tenantId ? { tenantId: item.tenantId } : {}),
          ...(item.ownerId ? { ownerId: item.ownerId } : {}),
          workspacePath: item.workspacePath,
          environment: item.environment,
          ...(collectorIds.length ? { collectorIds } : {}),
          ...(sourceIds.length ? { sourceIds } : {}),
          lifecycleState: item.lifecycleState,
          terminalContextIds: [...(item.terminalContextIds ?? [])].slice(0, 256),
          agentAssetIds: [...item.agentAssetIds].slice(0, 256),
          agentInstanceIds: [...item.agentInstanceIds].slice(0, 512),
          sessionIds,
          activeInstanceCount: item.activeInstanceCount,
          totalInstanceCount: item.totalInstanceCount,
          conversationCount: item.conversationCount,
          usage: structuredClone(item.usage),
          coverage: structuredClone(item.coverage),
          sourceRefs: [...new Set(sourceRefs)].slice(0, 64),
          resolutionRevision: directory.resolutionRevision,
        };
      });
    const resourceCoverageReasons = resources.flatMap((item) => item.coverage.reasons);
    const partial = directory.coverage.partial
      || Boolean(directory.coverage.partialReason)
      || resources.some((item) => item.coverage.status !== 'complete')
      || resourceCoverageReasons.length > 0;
    const coverage = this.canonicalRevisionCoverage(
      query,
      directory.resolutionRevision,
      canonicalScopeCoverage(query, canonicalCoverage(
        partial,
        [directory.coverage.partialReason ?? '', ...resourceCoverageReasons],
        directory.dataSource,
      ), {
        sourceId: resources.every((resource) => resource.sourceIds !== undefined),
        collectorId: resources.every((resource) => resource.collectorIds !== undefined),
      }),
    );
    return { items: resources, coverage, dataSource: directory.dataSource, revision: directory.resolutionRevision };
  }

  private async canonicalAgentInstanceResources(
    query: CanonicalEntityQuery,
    headers: HeaderBag,
  ): Promise<{
    items: T.CanonicalAgentInstanceResource[];
    coverage: T.CanonicalEntityCoverage;
    dataSource: string;
    revision: number;
  }> {
    const runtime = this.agentRuntimeState.list({
      collectorId: query.collectorId,
      sourceId: query.sourceId,
      agentInstanceId: query.agentInstanceId,
      physicalWorkloadId: undefined,
      includeShadow: query.includeShadow,
      limit: CANONICAL_RUNTIME_STATE_READ_LIMIT,
    });
    const directory = await this.canonicalDirectorySnapshot({ ...query, offset: 0, limit: 500 }, headers);
    const grouped = new Map<string, T.AgentRuntimeInstanceRecord[]>();
    for (const record of runtime.items) {
      const key = record.canonicalAgentInstanceId ?? record.agentInstanceId;
      const values = grouped.get(key) ?? [];
      values.push(record);
      grouped.set(key, values);
    }
    const resources = [...grouped.entries()].map(([instanceId, records]): T.CanonicalAgentInstanceResource => {
      const first = [...records].sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0];
      const matchingConversations = directory.items
        .flatMap((item) => item.userThreads ?? [])
        .filter((conversation) => conversation.agentInstanceIds.some((id) => records.some((record) => [
          record.agentInstanceId,
          record.canonicalAgentInstanceId,
          ...(record.agentInstanceAliases ?? []),
        ].includes(id))));
      const runtimeIds = [...new Set(records.flatMap((record) => [
        record.agentInstanceId,
        record.canonicalAgentInstanceId,
        ...(record.agentInstanceAliases ?? []),
      ].filter((value): value is string => Boolean(value))))];
      const sessionIds = [...new Set(matchingConversations.flatMap((conversation) => [
        conversation.sessionId,
        conversation.conversationId,
      ].filter((value): value is string => Boolean(value))))].slice(0, 512);
      const states = new Set(records.map((record) => record.runtimeState));
      const state: T.AgentRuntimeState = states.has('running')
        ? 'running'
        : states.has('unobserved') ? 'unobserved'
          : states.has('lost') ? 'lost' : 'exited';
      const classification = records.find((record) => record.classification)?.classification;
      const classificationDecision = captureClassificationDecision(classification);
      const coverage = matchingConversations.length
        ? canonicalCoverageFromSummaries(matchingConversations, 'runtime+conversation_projection')
        : { status: 'unknown' as const, reasons: ['runtime_without_conversation_projection'], source: 'runtime_state' };
      const sourceRefs = [...new Set(records.flatMap((record) => [
        `runtime-snapshot:${record.collectorId}:${record.snapshotVersion}`,
        ...runtimeIds.slice(0, 8).map((id) => `runtime:${id}`),
      ]))].slice(0, 64);
      return {
        schemaVersion: 'anysentry.agent_instance.v1',
        agentInstanceId: instanceId,
        ...(first.logicalAgentId ? { logicalAgentId: first.logicalAgentId } : {}),
        ...(first.logicalAgentCandidateId ? { logicalAgentCandidateId: first.logicalAgentCandidateId } : {}),
        ...(first.logicalDefinitionId ? { logicalDefinitionId: first.logicalDefinitionId } : {}),
        ...(first.logicalScopeMode ? { logicalScopeMode: first.logicalScopeMode } : {}),
        ...(first.logicalIdentityAuthority === 'management_registration'
          ? { logicalIdentityAuthority: first.logicalIdentityAuthority } : {}),
        ...(first.agentDisplayName ? { agentProduct: first.agentDisplayName, displayName: first.agentDisplayName } : {}),
        environment: canonicalRuntimeEnvironment(first),
        ...(first.tenantId ? { tenantId: first.tenantId } : {}),
        ...(first.ownerId ? { ownerId: first.ownerId } : {}),
        ...(first.workspacePath ? { workspacePath: first.workspacePath } : {}),
        ...(first.profile ? { profile: first.profile } : {}),
        ...(first.profileVersion ? { profileVersion: first.profileVersion } : {}),
        ...(first.deploymentId ? { deploymentId: first.deploymentId } : {}),
        ...(first.deploymentRevision ? { deploymentRevision: first.deploymentRevision } : {}),
        ...(first.environmentId ? { environmentId: first.environmentId } : {}),
        collectorId: first.collectorId,
        collectorIds: [...new Set(records.map((record) => record.collectorId))].slice(0, 64),
        ...(first.sourceId ? { sourceId: first.sourceId } : {}),
        sourceIds: [...new Set(records
          .map((record) => record.sourceId)
          .filter((value): value is string => Boolean(value)))].slice(0, 64),
        terminalContextIds: [...new Set(records
          .map((record) => record.terminalContextId)
          .filter((value): value is string => Boolean(value)))].slice(0, 256),
        runtimeInstanceIds: runtimeIds.slice(0, 512),
        sessionIds,
        state,
        startedAtUnixNs: canonicalMillisToUnixNs(Math.min(...records.map((record) => record.discoveredAt))) ?? '0',
        ...(records.some((record) => record.endedAt !== undefined)
          ? { endedAtUnixNs: canonicalMillisToUnixNs(Math.max(...records.map((record) => record.endedAt ?? 0))) } : {}),
        lastSeenAtUnixNs: canonicalMillisToUnixNs(Math.max(...records.map((record) => record.lastSeenAt))) ?? '0',
        sourceRefs,
        coverage,
        ...(classification ? { detectedClassification: classification } : {}),
        ...(classification ? { effectiveClassification: classificationDecision.effective } : {}),
        ...(classificationDecision.candidateAutoPromoted ? { candidateAutoPromoted: true } : {}),
        resolutionRevision: directory.resolutionRevision,
      };
    }).filter((resource) => canonicalLifecycleMatches(resource.state, query.lifecycleScope)
      && canonicalScopeMatches({
      logicalAgentId: resource.logicalAgentId,
      logicalAgentCandidateId: resource.logicalAgentCandidateId,
      logicalDefinitionId: resource.logicalDefinitionId,
      tenantId: resource.tenantId,
      ownerId: resource.ownerId,
      workspacePath: resource.workspacePath,
      environment: resource.environment,
      environmentId: resource.environmentId,
      agentAssetId: undefined,
      agentInstanceId: query.agentInstanceId && resource.runtimeInstanceIds.includes(query.agentInstanceId)
        ? query.agentInstanceId : resource.agentInstanceId,
      runtimeInstanceId: resource.runtimeInstanceIds[0],
      sessionId: resource.sessionIds[0],
      product: resource.agentProduct,
      classification: resource.detectedClassification,
      coverageStatus: resource.coverage.status,
      collectorId: resource.collectorId,
      collectorIds: resource.collectorIds,
      sourceId: resource.sourceId,
      sourceIds: resource.sourceIds,
      q: [resource.displayName, resource.agentProduct, resource.agentInstanceId, ...resource.runtimeInstanceIds].join(' '),
    }, query));
    // Runtime state is a useful bounded fallback, but it cannot make the missing conversation
    // projection complete. Preserve the directory timeout as partial even when runtime rows exist.
    const resourceCoverageReasons = resources.flatMap((item) => item.coverage.reasons);
    const partial = directory.coverage.partial
      || Boolean(directory.coverage.partialReason)
      || resources.some((item) => item.coverage.status !== 'complete')
      || resourceCoverageReasons.length > 0;
    const coverage = this.canonicalRevisionCoverage(
      query,
      directory.resolutionRevision,
      canonicalScopeCoverage(query, canonicalCoverage(partial, [directory.coverage.partialReason ?? '', ...resourceCoverageReasons], 'runtime_state+conversation_projection'), {
        sourceId: resources.every((resource) => resource.sourceIds !== undefined),
        collectorId: resources.every((resource) => resource.collectorIds !== undefined),
      }),
    );
    return { items: resources, coverage, dataSource: 'runtime_state+conversation_projection', revision: directory.resolutionRevision };
  }

  private async canonicalRuntimeInstanceResources(
    query: CanonicalEntityQuery,
    headers: HeaderBag,
  ): Promise<{
    items: T.CanonicalRuntimeInstanceResource[];
    coverage: T.CanonicalEntityCoverage;
    dataSource: string;
    revision: number;
  }> {
    const runtime = this.agentRuntimeState.list({
      collectorId: query.collectorId,
      sourceId: query.sourceId,
      agentInstanceId: query.agentInstanceId ?? query.runtimeInstanceId,
      physicalWorkloadId: query.agentAssetId,
      runtimeState: query.lifecycleScope === 'running' ? 'running' : 'all',
      includeShadow: query.includeShadow,
      limit: CANONICAL_RUNTIME_STATE_READ_LIMIT,
    });
    const directory = await this.canonicalDirectorySnapshot({ ...query, offset: 0, limit: 500 }, headers);
    const conversations = directory.items.flatMap((item) => item.userThreads ?? []);
    const resources = runtime.items.map((record): T.CanonicalRuntimeInstanceResource => {
      const runtimeInstanceId = record.agentInstanceId;
      const canonicalAgentInstanceId = record.canonicalAgentInstanceId;
      const processKey = canonicalRuntimeProcessKey(record);
      const matchingConversations = conversations.filter((conversation) => conversation.agentInstanceIds.some((id) => [
        record.agentInstanceId,
        canonicalAgentInstanceId,
        ...(record.agentInstanceAliases ?? []),
      ].includes(id)));
      const classificationDecision = captureClassificationDecision(record.classification);
      return {
        schemaVersion: 'anysentry.runtime_instance.v1',
        runtimeInstanceId,
        ...(canonicalAgentInstanceId ? { agentInstanceId: canonicalAgentInstanceId } : {}),
        legacyAgentInstanceId: runtimeInstanceId,
        ...(record.logicalAgentId ? { logicalAgentId: record.logicalAgentId } : {}),
        ...(record.logicalAgentCandidateId ? { logicalAgentCandidateId: record.logicalAgentCandidateId } : {}),
        ...(record.logicalDefinitionId ? { logicalDefinitionId: record.logicalDefinitionId } : {}),
        ...(record.logicalScopeMode ? { logicalScopeMode: record.logicalScopeMode } : {}),
        ...(record.logicalIdentityAuthority === 'management_registration'
          ? { logicalIdentityAuthority: record.logicalIdentityAuthority } : {}),
        ...(record.agentDisplayName ? { agentProduct: record.agentDisplayName, displayName: record.agentDisplayName } : {}),
        environment: canonicalRuntimeEnvironment(record),
        ...(record.tenantId ? { tenantId: record.tenantId } : {}),
        ...(record.ownerId ? { ownerId: record.ownerId } : {}),
        ...(record.environmentId ? { environmentId: record.environmentId } : {}),
        ...(record.profile ? { profile: record.profile } : {}),
        ...(record.profileVersion ? { profileVersion: record.profileVersion } : {}),
        ...(record.deploymentId ? { deploymentId: record.deploymentId } : {}),
        ...(record.deploymentRevision ? { deploymentRevision: record.deploymentRevision } : {}),
        collectorId: record.collectorId,
        ...(record.sourceId ? { sourceId: record.sourceId } : {}),
        hostId: record.hostId,
        bootId: record.bootId,
        rootPid: record.rootPid,
        rootStartTimeTicks: record.rootStartTimeTicks,
        processGenerationKeys: processKey ? [processKey] : [],
        ...(record.workspacePath ? { workspacePath: record.workspacePath } : {}),
        ...(record.physicalWorkloadId ? { physicalWorkloadId: record.physicalWorkloadId } : {}),
        ...(record.workloadRef ? { workloadRef: structuredClone(record.workloadRef) } : {}),
        ...(record.terminalContextId ? { terminalContextId: record.terminalContextId } : {}),
        ...(record.sshConnectionId ? { sshConnectionId: record.sshConnectionId } : {}),
        state: record.runtimeState,
        ...(record.activityState ? { activityState: record.activityState } : {}),
        startedAtUnixNs: canonicalMillisToUnixNs(record.discoveredAt) ?? '0',
        ...(record.endedAt !== undefined ? { endedAtUnixNs: canonicalMillisToUnixNs(record.endedAt) } : {}),
        lastSeenAtUnixNs: canonicalMillisToUnixNs(record.lastSeenAt) ?? '0',
        sourceRefs: [
          `runtime-snapshot:${record.collectorId}:${record.snapshotVersion}`,
          `runtime:${runtimeInstanceId}`,
          ...(processKey ? [`process-generation:${processKey}`] : []),
        ].slice(0, 64),
        coverage: matchingConversations.length
          ? canonicalCoverageFromSummaries(matchingConversations, 'runtime+conversation_projection')
          : { status: 'unknown', reasons: ['runtime_without_conversation_projection'], source: 'runtime_state' },
        ...(record.classification ? { detectedClassification: record.classification } : {}),
        ...(record.classification ? { effectiveClassification: classificationDecision.effective } : {}),
        ...(classificationDecision.candidateAutoPromoted ? { candidateAutoPromoted: true } : {}),
        resolutionRevision: directory.resolutionRevision,
      };
    }).filter((resource) => canonicalLifecycleMatches(resource.state, query.lifecycleScope)
      && canonicalScopeMatches({
      logicalAgentId: resource.logicalAgentId,
      logicalAgentCandidateId: resource.logicalAgentCandidateId,
      logicalDefinitionId: resource.logicalDefinitionId,
      tenantId: resource.tenantId,
      ownerId: resource.ownerId,
      workspacePath: resource.workspacePath,
      environment: resource.environment,
      environmentId: resource.environmentId,
      agentAssetId: resource.physicalWorkloadId,
      agentInstanceId: resource.agentInstanceId,
      runtimeInstanceId: resource.runtimeInstanceId,
      sessionId: undefined,
      product: resource.agentProduct,
      classification: resource.detectedClassification,
      coverageStatus: resource.coverage.status,
      collectorId: resource.collectorId,
      sourceId: resource.sourceId,
      q: [resource.displayName, resource.agentProduct, resource.runtimeInstanceId, resource.workspacePath].join(' '),
    }, query));
    const coverage = this.canonicalRevisionCoverage(
      query,
      directory.resolutionRevision,
      canonicalScopeCoverage(query, canonicalCoverage(
        directory.coverage.partial || Boolean(directory.coverage.partialReason)
          || resources.some((item) => item.coverage.status !== 'complete'),
        [directory.coverage.partialReason ?? '', ...resources.flatMap((item) => item.coverage.reasons)],
        'runtime_state+conversation_projection',
      ), { sourceId: resources.every((resource) => resource.sourceId !== undefined), collectorId: true }),
    );
    return { items: resources, coverage, dataSource: 'runtime_state+conversation_projection', revision: directory.resolutionRevision };
  }

  private async canonicalSessionResources(
    query: CanonicalEntityQuery,
    headers: HeaderBag,
  ): Promise<CanonicalSessionProjection> {
    this.pruneCanonicalSessionCache();
    const key = this.canonicalSessionCacheKey(query, headers);
    const cached = this.canonicalSessionCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.canonicalSessionCache.delete(key);
      this.canonicalSessionCache.set(key, cached);
      return cached.value;
    }
    const inFlight = this.canonicalSessionInFlight.get(key);
    if (inFlight) return inFlight;
    if (this.canonicalSessionInFlight.size >= CANONICAL_SESSION_INFLIGHT_MAX) {
      throw new ServiceUnavailableException('Canonical session projection is busy; retry the latest selection');
    }
    const operation = this.computeCanonicalSessionResources(query, headers)
      .then((value) => {
        this.rememberCanonicalSessionProjection(key, value);
        return value;
      })
      .finally(() => {
        if (this.canonicalSessionInFlight.get(key) === operation) {
          this.canonicalSessionInFlight.delete(key);
        }
      });
    this.canonicalSessionInFlight.set(key, operation);
    return withCanonicalProjectionTimeout(operation, CANONICAL_SESSION_PROJECTION_TIMEOUT_MS)
      .catch((error) => {
        if (!isCanonicalProjectionDegradation(error)) throw error;
        if (this.canonicalSessionInFlight.get(key) === operation) {
          this.canonicalSessionInFlight.delete(key);
        }
        const fallback = this.degradedCanonicalSessionProjection(query, 'session_projection_timeout');
        this.rememberCanonicalSessionProjection(key, fallback);
        return fallback;
      });
  }

  private degradedCanonicalSessionProjection(
    query: CanonicalEntityQuery,
    reason: string,
  ): CanonicalSessionProjection {
    const memberships = this.canonicalObservability.sessionMemberships
      .list(Math.min(10_000, Math.max(1, query.limit + query.offset)));
    const resources = new Map<string, T.CanonicalSessionResource>();
    for (const membership of memberships) {
      // SessionMembership.sessionId is already the server-derived canonical ID.  Unlike a
      // SemanticRecord/compatibility summary, a membership row has no separate canonicalSessionId
      // alias; treating a missing field as a second identity would both fail type checking and
      // risk manufacturing a new session during degraded reads.
      const candidateIds = [membership.sessionId];
      if (query.sessionId && !candidateIds.includes(query.sessionId)) continue;
      if (query.agentInstanceId && membership.agentInstanceId !== query.agentInstanceId) continue;
      if (query.logicalAgentId && membership.logicalAgentId !== query.logicalAgentId) continue;
      const sessionId = membership.sessionId;
      if (resources.has(sessionId)) continue;
      // `candidate` is a discovery classification, not a valid canonical Session quality. Keep
      // the degraded projection honest by exposing it as unresolved rather than widening the
      // public Session contract or claiming confirmation.
      const sessionIdentityQuality: T.SessionIdentityQuality = membership.confidence === 'candidate'
        ? 'unresolved'
        : membership.confidence;
      const zeroUsage: T.AgentUsageSummary = {
        modelCallCount: 0,
        successfulModelCallCount: 0,
        failedModelCallCount: 0,
        tokenReportedModelCallCount: 0,
        tokenCoverage: 'unavailable',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
        totalDurationMs: 0,
      };
      resources.set(sessionId, {
        schemaVersion: 'anysentry.session.v1',
        sessionId,
        ...(membership.sessionKey ? { sessionKey: membership.sessionKey } : {}),
        ...(membership.providerSessionIdHash ? { providerSessionIdHash: membership.providerSessionIdHash } : {}),
        ...(membership.logicalAgentId ? { logicalAgentId: membership.logicalAgentId } : {}),
        ...(membership.agentInstanceId ? { agentInstanceIds: [membership.agentInstanceId] } : { agentInstanceIds: [] }),
        ...(membership.segmentId ? { segmentIds: [membership.segmentId] } : { segmentIds: [] }),
        ...(membership.interactionId ? { interactionIds: [membership.interactionId] } : { interactionIds: [] }),
        ...(membership.parentSessionId ? { parentSessionId: membership.parentSessionId } : {}),
        ...(membership.canonicalParentSessionId ? { canonicalParentSessionId: membership.canonicalParentSessionId } : {}),
        sessionIdentityQuality,
        ...(membership.sessionMode ? { sessionMode: membership.sessionMode } : {}),
        ...(membership.sessionLifecycle ? { sessionLifecycle: membership.sessionLifecycle } : {}),
        turnCount: 0,
        modelCallCount: 0,
        toolCallCount: 0,
        toolResultCount: 0,
        errorCount: 0,
        usage: zeroUsage,
        coverage: {
          status: 'asset_only',
          reasons: [reason],
          completeInteractions: 0,
          partialInteractions: 0,
        },
        sourceRefs: [...new Set([
          `session-membership:${membership.membershipId}`,
          ...membership.sourceRefs,
        ])].slice(0, 64),
        resolutionRevision: membership.resolutionRevision,
      });
    }
    return {
      items: [...resources.values()],
      coverage: canonicalCoverage(true, [reason], 'memory_hot_ring'),
      dataSource: 'memory_hot_ring',
      revision: this.canonicalCurrentRevision(),
    };
  }

  private async computeCanonicalSessionResources(
    query: CanonicalEntityQuery,
    headers: HeaderBag,
  ): Promise<CanonicalSessionProjection> {
    const conversations = await this.agg.agentConversations({
      timeType: query.timeType,
      startTime: query.startTime,
      endTime: query.endTime,
      snapshotAsOf: query.snapshotAsOf,
      scope: 'raw',
      classificationView: query.classificationView,
      agentAssetId: query.agentAssetId,
      agentInstanceId: query.agentInstanceId,
      product: query.product,
      q: query.q,
      limit: 500,
    });
    const memberships = await this.canonicalObservability.listDurableSessionMemberships(10_000);
    const membershipBySession = new Map<string, T.SessionMembership[]>();
    for (const membership of memberships) {
      const values = membershipBySession.get(membership.sessionId) ?? [];
      values.push(membership);
      membershipBySession.set(membership.sessionId, values);
    }
    const resourcesByKey = new Map<string, T.CanonicalSessionResource>();
    for (const summary of conversations.items) {
      // An asset-only compatibility summary is an Agent/runtime placeholder, not a Session. It is
      // exposed by the legacy directory for discovery but must not manufacture a Canonical Session
      // without a semantic interaction or a persisted SessionMembership.
      if (!summary.hasContent) continue;
      const sessionId = canonicalSessionIdentity(summary);
      const related = [
        ...(membershipBySession.get(sessionId) ?? []),
        ...(membershipBySession.get(summary.conversationId) ?? []),
        ...memberships.filter((membership) =>
          membership.logicalAgentId
          && summary.logicalAgentId
          && membership.logicalAgentId === summary.logicalAgentId
          && ((summary.providerSessionIdHash
            && membership.providerSessionIdHash === summary.providerSessionIdHash)
            || (membership.agentInstanceId
              && summary.agentInstanceIds.includes(membership.agentInstanceId)))),
      ];
      const interactionIds = [...new Set(related
        .map((membership) => membership.interactionId)
        .filter((value): value is string => Boolean(value)))].slice(0, 2_048);
      const segmentIds = [...new Set(related
        .map((membership) => membership.segmentId)
        .filter((value): value is string => Boolean(value)))].slice(0, 512);
      const canonicalMembership = related.find((membership) => Boolean(membership.sessionKey));
      const canonicalSessionId = canonicalMembership?.sessionId;
      const key = canonicalSessionId ?? sessionId;
      const existing = resourcesByKey.get(key);
      if (existing) {
        existing.agentInstanceIds = [...new Set([...existing.agentInstanceIds, ...summary.agentInstanceIds])].slice(0, 512);
        existing.interactionIds = [...new Set([...existing.interactionIds, ...interactionIds])].slice(0, 2_048);
        existing.segmentIds = [...new Set([...existing.segmentIds, ...segmentIds])].slice(0, 512);
        existing.agentAssetIds = [...new Set([
          ...(existing.agentAssetIds ?? []),
          ...(summary.agentAssetIds ?? [summary.agentAssetId]),
        ].filter((value): value is string => Boolean(value)))].slice(0, 256);
        continue;
      }
      resourcesByKey.set(key, {
        schemaVersion: 'anysentry.session.v1',
        sessionId: key,
        ...(summary.sessionId && summary.sessionId !== key ? { canonicalSessionId: key } : {}),
        ...(summary.sessionKey ? { sessionKey: summary.sessionKey } : {}),
        ...(summary.providerSessionIdHash ? { providerSessionIdHash: summary.providerSessionIdHash } : {}),
        conversationId: summary.conversationId,
        ...(summary.logicalAgentId ? { logicalAgentId: summary.logicalAgentId } : {}),
        ...(summary.logicalAgentCandidateId ? { logicalAgentCandidateId: summary.logicalAgentCandidateId } : {}),
        ...(summary.logicalDefinitionId ? { logicalDefinitionId: summary.logicalDefinitionId } : {}),
        ...(summary.logicalScopeMode ? { logicalScopeMode: summary.logicalScopeMode } : {}),
        ...(summary.logicalIdentityAuthority ? { logicalIdentityAuthority: summary.logicalIdentityAuthority } : {}),
        ...(summary.tenantId ? { tenantId: summary.tenantId } : {}),
        ...(summary.ownerId ? { ownerId: summary.ownerId } : {}),
        ...(summary.agentProduct ? { agentProduct: summary.agentProduct } : {}),
        ...(summary.environment ? { environment: summary.environment } : {}),
        ...(summary.workspacePath ? { workspacePath: summary.workspacePath } : {}),
        agentAssetIds: [...new Set(summary.agentAssetIds ?? [summary.agentAssetId])]
          .filter((value): value is string => Boolean(value))
          .slice(0, 256),
        agentInstanceIds: [...summary.agentInstanceIds].slice(0, 512),
        segmentIds,
        interactionIds,
        ...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
        ...(summary.canonicalParentSessionId ? { canonicalParentSessionId: summary.canonicalParentSessionId } : {}),
        ...(summary.sessionIdentityQuality ? { sessionIdentityQuality: summary.sessionIdentityQuality } : {}),
        ...(summary.sessionMode ? { sessionMode: summary.sessionMode } : {}),
        ...(summary.sessionLifecycle ? { sessionLifecycle: summary.sessionLifecycle } : {}),
        ...(summary.startedAtUnixNs ? { startedAtUnixNs: summary.startedAtUnixNs } : {}),
        ...(summary.lastActivityAtUnixNs ? { lastActivityAtUnixNs: summary.lastActivityAtUnixNs } : {}),
        turnCount: summary.turnCount,
        modelCallCount: summary.modelCallCount,
        toolCallCount: summary.toolCallCount,
        toolResultCount: summary.toolResultCount,
        errorCount: summary.errorCount,
        usage: structuredClone(summary.usage),
        coverage: structuredClone(summary.coverage),
        sourceRefs: [...new Set([
          ...canonicalConversationSourceRefs(summary),
          ...related.flatMap((membership) => membership.sourceRefs),
        ])].slice(0, 128),
        resolutionRevision: Math.max(
          this.canonicalCurrentRevision(),
          ...related.map((membership) => membership.resolutionRevision),
        ),
      });
    }
    // Memberships are the canonical session lane even when a semantic projection has expired.
    for (const membership of memberships) {
      if ([...resourcesByKey.values()].some((resource) => [
        resource.sessionId,
        resource.canonicalSessionId,
        resource.conversationId,
      ].includes(membership.sessionId))) continue;
      resourcesByKey.set(membership.sessionId, {
        schemaVersion: 'anysentry.session.v1',
        sessionId: membership.sessionId,
        ...(membership.sessionKey ? { sessionKey: membership.sessionKey } : {}),
        ...(membership.providerSessionIdHash ? { providerSessionIdHash: membership.providerSessionIdHash } : {}),
        ...(membership.logicalAgentId ? { logicalAgentId: membership.logicalAgentId } : {}),
        ...(membership.agentInstanceId ? { agentInstanceIds: [membership.agentInstanceId] } : { agentInstanceIds: [] }),
        segmentIds: membership.segmentId ? [membership.segmentId] : [],
        interactionIds: membership.interactionId ? [membership.interactionId] : [],
        ...(membership.parentSessionId ? { parentSessionId: membership.parentSessionId } : {}),
        ...(membership.canonicalParentSessionId ? { canonicalParentSessionId: membership.canonicalParentSessionId } : {}),
        ...(membership.confidence && ['confirmed', 'strong', 'inferred', 'unresolved', 'ephemeral', 'unknown', 'conflict'].includes(membership.confidence)
          ? { sessionIdentityQuality: membership.confidence as T.SessionIdentityQuality } : {}),
        ...(membership.sessionMode ? { sessionMode: membership.sessionMode } : {}),
        ...(membership.sessionLifecycle ? { sessionLifecycle: membership.sessionLifecycle } : {}),
        turnCount: 0,
        modelCallCount: 0,
        toolCallCount: 0,
        toolResultCount: 0,
        errorCount: 0,
        usage: {
          modelCallCount: 0,
          successfulModelCallCount: 0,
          failedModelCallCount: 0,
          tokenReportedModelCallCount: 0,
          tokenCoverage: 'unavailable',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
          totalDurationMs: 0,
        },
        coverage: {
          status: 'asset_only',
          reasons: ['semantic_projection_expired_or_missing'],
          completeInteractions: 0,
          partialInteractions: 0,
        },
        sourceRefs: [...new Set([`session-membership:${membership.membershipId}`, ...membership.sourceRefs])].slice(0, 64),
        resolutionRevision: membership.resolutionRevision,
      });
    }
    const resources = [...resourcesByKey.values()].filter((resource) => canonicalScopeMatches({
      logicalAgentId: resource.logicalAgentId,
      logicalAgentCandidateId: resource.logicalAgentCandidateId,
      logicalDefinitionId: resource.logicalDefinitionId,
      tenantId: resource.tenantId,
      ownerId: resource.ownerId,
      workspacePath: resource.workspacePath,
      agentAssetIds: resource.agentAssetIds,
      environment: resource.environment,
      environmentId: undefined,
      agentAssetId: undefined,
      agentInstanceId: resource.agentInstanceIds[0],
      agentInstanceIds: resource.agentInstanceIds,
      runtimeInstanceId: resource.agentInstanceIds[0],
      runtimeInstanceIds: resource.agentInstanceIds,
      sessionId: resource.sessionId,
      sessionIds: [resource.sessionId, resource.canonicalSessionId, resource.conversationId]
        .filter((value): value is string => Boolean(value)),
      product: resource.agentProduct,
      classification: undefined,
      coverageStatus: resource.coverage.status,
      sourceId: resource.sourceIds?.[0],
      sourceIds: resource.sourceIds,
      collectorId: resource.collectorIds?.[0],
      collectorIds: resource.collectorIds,
      q: [resource.sessionId, resource.conversationId, resource.agentProduct, resource.workspacePath].join(' '),
    }, query));
    const revision = Math.max(this.canonicalCurrentRevision(), ...resources.map((resource) => resource.resolutionRevision));
    const resourceCoverageReasons = resources.flatMap((resource) => resource.coverage.reasons);
    const coverage = this.canonicalRevisionCoverage(
      query,
      revision,
      canonicalScopeCoverage(query, canonicalCoverage(
        conversations.coverage.partial
          || Boolean(conversations.coverage.partialReason)
          || resources.some((resource) => resource.coverage.status !== 'complete')
          || resourceCoverageReasons.length > 0,
        [conversations.coverage.partialReason ?? '', ...resourceCoverageReasons],
        conversations.dataSource,
      ), false),
    );
    return { items: resources, coverage, dataSource: conversations.dataSource, revision };
  }

  /**
   * Resolve the two canonical semantic identifier families used by the read models.  Durable
   * parser records use `sr_…`; the conversation timeline deliberately derives a separate stable
   * `se_…` event id.  The bridge is computed from immutable session/interaction references and is
   * bounded to the same 500-session/500-event read limits as the public projections.
   */
  private async canonicalSemanticTimelineCandidates(
    requestedId: string,
    semanticRecord: SemanticRecord | undefined,
    query: CanonicalEntityQuery,
    sessions: readonly T.CanonicalSessionResource[],
  ): Promise<CanonicalSemanticTimelineSearch> {
    const scopedSessions = semanticRecord
      ? sessions.filter((session) => canonicalSemanticRecordTouchesSession(semanticRecord, session))
      : sessions;
    // A durable record can outlive the summary's session alias.  If no direct scope matched, a
    // bounded fallback scan still permits sourceInteractionIds to establish the relationship.
    const allCandidates = scopedSessions.length > 0 ? scopedSessions : sessions;
    const candidates = allCandidates.slice(0, CANONICAL_SEMANTIC_SESSION_SCAN_MAX);
    const result: CanonicalSemanticTimelineCandidate[] = [];
    const seen = new Set<string>();
    let failed = 0;
    // Timeline projection can perform a ClickHouse read. Keep a small worker width and stop once
    // two distinct matches are found: the caller must preserve ambiguity and has no reason to
    // scan the remaining sessions. A stale/failed projection is a coverage gap, not a 500.
    for (let offset = 0; offset < candidates.length && result.length < 2; offset += CANONICAL_SEMANTIC_SCAN_CONCURRENCY) {
      const batch = candidates.slice(offset, offset + CANONICAL_SEMANTIC_SCAN_CONCURRENCY);
      const scanned = await Promise.all(batch.map(async (session) => {
        const conversationId = session.conversationId ?? session.sessionId;
        if (!conversationId) return [] as CanonicalSemanticTimelineCandidate[];
        try {
          const timeline = await this.agg.agentConversationTimelineV3({
            timeType: query.timeType,
            startTime: query.startTime,
            endTime: query.endTime,
            snapshotAsOf: query.snapshotAsOf,
            // Canonical reads are evidence/audit views. Keep unknown/candidate interactions in
            // the projection and expose their lower semantic coverage instead of filtering them
            // out as the ordinary Agent dashboard does.
            scope: 'raw',
            classificationView: query.classificationView,
            conversationId,
            limit: 500,
          });
          const matches: CanonicalSemanticTimelineCandidate[] = [];
          for (const turn of timeline.turns) {
            for (const event of turn.events) {
              if (semanticRecord
                ? !canonicalSemanticRecordTouchesEvent(semanticRecord, event)
                : event.semanticEventId !== requestedId) {
                continue;
              }
              matches.push({ session, event });
            }
          }
          return matches;
        } catch (error) {
          // Internal session IDs were already validated by canonicalSessionResources. A backend
          // timeout, expired projection, or stale membership therefore degrades coverage; retain
          // the durable row/Kernel lane instead of converting it into an HTTP 500. Do not swallow
          // a programmer-visible parameter error if one somehow escapes the internal call.
          if (!isCanonicalProjectionDegradation(error)) throw error;
          failed += 1;
          return [] as CanonicalSemanticTimelineCandidate[];
        }
      }));
      for (const matches of scanned) {
        for (const candidate of matches) {
          const key = `${candidate.session.sessionId}\u0000${candidate.event.semanticEventId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          result.push(candidate);
          if (result.length >= 2) break;
        }
        if (result.length >= 2) break;
      }
    }
    return {
      candidates: result,
      scanned: candidates.length,
      truncated: allCandidates.length > candidates.length,
      failed,
    };
  }

  /**
   * Resolve a semantic deep link directly from the bounded compatibility interaction projection.
   * Canonical Session rows can legitimately lag (for example while PostgreSQL is under I/O
   * pressure), but the ClickHouse interaction row still contains the immutable semantic items.
   * Asset/instance-scoped requests use this path before the more expensive session scan so a
   * valid `se_…` identifier does not become a false 404/ambiguous result.
   */
  private async legacySemanticTimelineCandidates(
    requestedId: string,
    semanticRecord: SemanticRecord | undefined,
    query: CanonicalEntityQuery,
  ): Promise<CanonicalSemanticTimelineSearch> {
    const candidates: CanonicalSemanticTimelineCandidate[] = [];
    let failed = 0;
    const conversationQueries: T.AgentConversationQuery[] = [{
      timeType: query.timeType,
      startTime: query.startTime,
      endTime: query.endTime,
      snapshotAsOf: query.snapshotAsOf,
      scope: 'raw',
      classificationView: query.classificationView,
      agentAssetId: query.agentAssetId,
      agentInstanceId: query.agentInstanceId,
      product: query.product,
      q: query.q,
      limit: 64,
    }];
    // A conversation may contain several physical assets. If the requested semantic event was
    // emitted by a sandbox/worker asset but the caller selected the LLM asset (or vice versa), a
    // filtered projection can hide the group before the timeline is built. Retry once without the
    // physical asset predicates; the resulting summary still carries all aliases and is checked
    // by the canonical scope matcher before it is returned.
    if (query.agentAssetId || query.agentInstanceId) {
      conversationQueries.push({
        timeType: query.timeType,
        startTime: query.startTime,
        endTime: query.endTime,
        snapshotAsOf: query.snapshotAsOf,
        scope: 'raw',
        classificationView: query.classificationView,
        product: query.product,
        q: query.q,
        limit: 64,
      });
    }
    let scanned = 0;
    for (const conversationQuery of conversationQueries) {
      let conversations: T.AgentConversationList;
      try {
        conversations = await this.agg.agentConversations(conversationQuery);
      } catch (error) {
        if (!isCanonicalProjectionDegradation(error)) throw error;
        failed += 1;
        continue;
      }
      scanned += conversations.items.length;
      for (const summary of conversations.items.slice(0, 64)) {
        if (!summary.hasContent || !summary.conversationId) continue;
        try {
          const timeline = await this.agg.agentConversationTimelineV3({
          timeType: query.timeType,
          startTime: query.startTime,
          endTime: query.endTime,
          snapshotAsOf: query.snapshotAsOf,
          scope: 'raw',
          classificationView: query.classificationView,
          conversationId: summary.conversationId,
          limit: 500,
          });
          for (const turn of timeline.turns) {
            for (const event of turn.events) {
              if (semanticRecord
                ? !canonicalSemanticRecordTouchesEvent(semanticRecord, event)
                : event.semanticEventId !== requestedId) continue;
              const session: T.CanonicalSessionResource = {
              schemaVersion: 'anysentry.session.v1',
              sessionId: summary.sessionId ?? summary.conversationId,
              ...(summary.sessionId && summary.sessionId !== summary.conversationId
                ? { canonicalSessionId: summary.conversationId } : {}),
              ...(summary.sessionKey ? { sessionKey: summary.sessionKey } : {}),
              ...(summary.providerSessionIdHash ? { providerSessionIdHash: summary.providerSessionIdHash } : {}),
              conversationId: summary.conversationId,
              ...(summary.logicalAgentId ? { logicalAgentId: summary.logicalAgentId } : {}),
              ...(summary.logicalAgentCandidateId ? { logicalAgentCandidateId: summary.logicalAgentCandidateId } : {}),
              ...(summary.logicalDefinitionId ? { logicalDefinitionId: summary.logicalDefinitionId } : {}),
              ...(summary.logicalScopeMode ? { logicalScopeMode: summary.logicalScopeMode } : {}),
              ...(summary.logicalIdentityAuthority ? { logicalIdentityAuthority: summary.logicalIdentityAuthority } : {}),
              ...(summary.tenantId ? { tenantId: summary.tenantId } : {}),
              ...(summary.ownerId ? { ownerId: summary.ownerId } : {}),
              ...(summary.agentProduct ? { agentProduct: summary.agentProduct } : {}),
              ...(summary.environment ? { environment: summary.environment } : {}),
              ...(summary.workspacePath ? { workspacePath: summary.workspacePath } : {}),
              agentAssetIds: [...new Set(summary.agentAssetIds ?? [summary.agentAssetId])]
                .filter((value): value is string => Boolean(value))
                .slice(0, 256),
              agentInstanceIds: [...summary.agentInstanceIds].slice(0, 512),
              segmentIds: [],
              interactionIds: [],
              ...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
              ...(summary.canonicalParentSessionId ? { canonicalParentSessionId: summary.canonicalParentSessionId } : {}),
              ...(summary.sessionIdentityQuality ? { sessionIdentityQuality: summary.sessionIdentityQuality } : {}),
              ...(summary.sessionMode ? { sessionMode: summary.sessionMode } : {}),
              ...(summary.sessionLifecycle ? { sessionLifecycle: summary.sessionLifecycle } : {}),
              ...(summary.startedAtUnixNs ? { startedAtUnixNs: summary.startedAtUnixNs } : {}),
              ...(summary.lastActivityAtUnixNs ? { lastActivityAtUnixNs: summary.lastActivityAtUnixNs } : {}),
              turnCount: summary.turnCount,
              modelCallCount: summary.modelCallCount,
              toolCallCount: summary.toolCallCount,
              toolResultCount: summary.toolResultCount,
              errorCount: summary.errorCount,
              usage: structuredClone(summary.usage),
              coverage: structuredClone(summary.coverage),
              sourceRefs: canonicalConversationSourceRefs(summary).slice(0, 64),
              resolutionRevision: this.canonicalCurrentRevision(),
            };
              // Do not widen an explicitly scoped request to an unrelated conversation merely
              // because the unscoped retry found a matching semantic hash.
              if (!canonicalScopeMatches({
                agentAssetIds: session.agentAssetIds,
                agentInstanceId: session.agentInstanceIds[0],
                agentInstanceIds: session.agentInstanceIds,
                runtimeInstanceId: session.agentInstanceIds[0],
                runtimeInstanceIds: session.agentInstanceIds,
                sessionId: session.sessionId,
                sessionIds: [session.sessionId, session.canonicalSessionId, session.conversationId]
                  .filter((value): value is string => Boolean(value)),
                logicalAgentId: session.logicalAgentId,
                logicalDefinitionId: session.logicalDefinitionId,
                workspacePath: session.workspacePath,
                product: session.agentProduct,
              }, query)) continue;
              candidates.push({ session, event });
            }
          }
        } catch (error) {
          if (!isCanonicalProjectionDegradation(error)) throw error;
          failed += 1;
        }
        if (candidates.length >= 2) break;
      }
      if (candidates.length >= 2) break;
    }
    return {
      candidates,
      scanned: Math.min(scanned, 128),
      truncated: scanned > 128,
      failed,
      exactUnique: Boolean(
        candidates.length === 1
        && requestedId.startsWith('se_')
        && (query.agentAssetId || query.agentInstanceId),
      ),
    };
  }

  @Get('v1/logical-agents')
  @RequireManagementAuth()
  async canonicalLogicalAgents(@Query() rawQuery: Record<string, unknown>, @Headers() headers: HeaderBag): Promise<T.CanonicalLogicalAgentList> {
    const query = parseCanonicalEntityQuery(rawQuery);
    const result = await this.canonicalLogicalAgentResources(query, headers);
    const page = canonicalPage(result.items, query);
    this.audit.record({
      actor: auditActor(headers),
      action: 'agent.conversation.content.list',
      resourceType: 'agent',
      resourceId: query.logicalAgentId ?? 'collection',
      summary: `Read ${page.items.length} canonical LogicalAgent resource(s)`,
      details: { total: page.total, limit: query.limit, offset: query.offset, revision: result.revision },
    });
    return {
      schemaVersion: 'anysentry.logical_agent.list.v1',
      ...page,
      revision: result.revision,
      coverage: query.includeCoverage ? result.coverage : canonicalCoverage(false, [], result.dataSource),
      dataSource: result.dataSource,
      updateTime: new Date().toISOString(),
    };
  }

  @Get('v1/logical-agents/:logicalAgentId')
  @RequireManagementAuth()
  async canonicalLogicalAgent(@Param('logicalAgentId') logicalAgentId: string, @Query() rawQuery: Record<string, unknown>, @Headers() headers: HeaderBag) {
    const query = parseCanonicalEntityQuery({ ...rawQuery, logicalAgentId });
    const result = await this.canonicalLogicalAgentResources(query, headers);
    const item = result.items.find((candidate) => candidate.logicalAgentId === logicalAgentId || candidate.logicalAgentCandidateId === logicalAgentId);
    if (!item) throw new NotFoundException('logical agent not found');
    return {
      schemaVersion: 'anysentry.logical_agent.v1',
      item,
      revision: result.revision,
      coverage: result.coverage,
      dataSource: result.dataSource,
      updateTime: new Date().toISOString(),
    };
  }

  @Get('v1/logical-agents/:logicalAgentId/instances')
  @RequireManagementAuth()
  async canonicalLogicalAgentInstances(@Param('logicalAgentId') logicalAgentId: string, @Query() rawQuery: Record<string, unknown>, @Headers() headers: HeaderBag): Promise<T.CanonicalAgentInstanceList> {
    const query = parseCanonicalEntityQuery({ ...rawQuery, logicalAgentId });
    const result = await this.canonicalAgentInstanceResources(query, headers);
    const filtered = result.items.filter((item) => item.logicalAgentId === logicalAgentId
      || item.logicalAgentCandidateId === logicalAgentId);
    const page = canonicalPage(filtered, query);
    return {
      schemaVersion: 'anysentry.agent_instance.list.v1',
      ...page,
      revision: result.revision,
      coverage: result.coverage,
      dataSource: result.dataSource,
      updateTime: new Date().toISOString(),
    };
  }

  @Get('v1/agent-instances')
  @RequireManagementAuth()
  async canonicalAgentInstances(@Query() rawQuery: Record<string, unknown>, @Headers() headers: HeaderBag): Promise<T.CanonicalAgentInstanceList> {
    const query = parseCanonicalEntityQuery(rawQuery);
    const result = await this.canonicalAgentInstanceResources(query, headers);
    const page = canonicalPage(result.items, query);
    this.audit.record({ actor: auditActor(headers), action: 'agent.conversation.content.list', resourceType: 'agent', resourceId: 'agent-instance-collection', summary: `Read ${page.items.length} canonical AgentInstance resource(s)`, details: { total: page.total, revision: result.revision } });
    return { schemaVersion: 'anysentry.agent_instance.list.v1', ...page, revision: result.revision, coverage: query.includeCoverage ? result.coverage : canonicalCoverage(false, [], result.dataSource), dataSource: result.dataSource, updateTime: new Date().toISOString() };
  }

  @Get('v1/agent-instances/:agentInstanceId')
  @RequireManagementAuth()
  async canonicalAgentInstance(@Param('agentInstanceId') agentInstanceId: string, @Query() rawQuery: Record<string, unknown>, @Headers() headers: HeaderBag) {
    const query = parseCanonicalEntityQuery({ ...rawQuery, agentInstanceId });
    const result = await this.canonicalAgentInstanceResources(query, headers);
    const item = result.items.find((candidate) => candidate.agentInstanceId === agentInstanceId || candidate.runtimeInstanceIds.includes(agentInstanceId));
    if (!item) throw new NotFoundException('agent instance not found');
    return { schemaVersion: 'anysentry.agent_instance.v1', item, revision: result.revision, coverage: result.coverage, dataSource: result.dataSource, updateTime: new Date().toISOString() };
  }

  @Get('v1/agent-instances/:agentInstanceId/runtimes')
  @RequireManagementAuth()
  async canonicalAgentInstanceRuntimes(@Param('agentInstanceId') agentInstanceId: string, @Query() rawQuery: Record<string, unknown>, @Headers() headers: HeaderBag): Promise<T.CanonicalRuntimeInstanceList> {
    const query = parseCanonicalEntityQuery({ ...rawQuery, agentInstanceId });
    const result = await this.canonicalRuntimeInstanceResources(query, headers);
    const filtered = result.items.filter((item) => item.agentInstanceId === agentInstanceId);
    const page = canonicalPage(filtered, query);
    return { schemaVersion: 'anysentry.runtime_instance.list.v1', ...page, revision: result.revision, coverage: result.coverage, dataSource: result.dataSource, updateTime: new Date().toISOString() };
  }

  @Get('v1/agent-instances/:agentInstanceId/sessions')
  @RequireManagementAuth()
  async canonicalAgentInstanceSessions(@Param('agentInstanceId') agentInstanceId: string, @Query() rawQuery: Record<string, unknown>, @Headers() headers: HeaderBag): Promise<T.CanonicalSessionList> {
    const query = parseCanonicalEntityQuery({ ...rawQuery, agentInstanceId });
    // The conversation store may expose the legacy runtime alias while the caller follows the
    // canonical functional AgentInstance ID.  Try the narrow query first, then use the same
    // bounded read model without the ID predicate and filter aliases locally.  Both paths are
    // read-only and preserve the source coverage/revision metadata.
    let result = await this.canonicalSessionResources(query, headers);
    let filtered = result.items.filter((item) => item.agentInstanceIds.includes(agentInstanceId));
    if (filtered.length === 0) {
      const broadQuery = { ...query, agentInstanceId: undefined, offset: 0, limit: 500 };
      const broad = await this.canonicalSessionResources(broadQuery, headers);
      const broadFiltered = broad.items.filter((item) => item.agentInstanceIds.includes(agentInstanceId));
      if (broadFiltered.length > 0 || result.items.length === 0) {
        result = broad;
        filtered = broadFiltered;
      }
    }
    const page = canonicalPage(filtered, query);
    return {
      schemaVersion: 'anysentry.session.list.v1',
      ...page,
      revision: result.revision,
      coverage: result.coverage,
      dataSource: result.dataSource,
      updateTime: new Date().toISOString(),
    };
  }

  @Get('v1/runtime-instances')
  @RequireManagementAuth()
  async canonicalRuntimeInstances(@Query() rawQuery: Record<string, unknown>, @Headers() headers: HeaderBag): Promise<T.CanonicalRuntimeInstanceList> {
    const query = parseCanonicalEntityQuery(rawQuery);
    const result = await this.canonicalRuntimeInstanceResources(query, headers);
    const page = canonicalPage(result.items, query);
    this.audit.record({ actor: auditActor(headers), action: 'agent.conversation.content.list', resourceType: 'agent', resourceId: 'runtime-instance-collection', summary: `Read ${page.items.length} canonical RuntimeInstance resource(s)`, details: { total: page.total, revision: result.revision } });
    return { schemaVersion: 'anysentry.runtime_instance.list.v1', ...page, revision: result.revision, coverage: query.includeCoverage ? result.coverage : canonicalCoverage(false, [], result.dataSource), dataSource: result.dataSource, updateTime: new Date().toISOString() };
  }

  @Get('v1/runtime-instances/:runtimeInstanceId')
  @RequireManagementAuth()
  async canonicalRuntimeInstance(@Param('runtimeInstanceId') runtimeInstanceId: string, @Query() rawQuery: Record<string, unknown>, @Headers() headers: HeaderBag) {
    const query = parseCanonicalEntityQuery({ ...rawQuery, runtimeInstanceId });
    const result = await this.canonicalRuntimeInstanceResources(query, headers);
    const item = result.items.find((candidate) => candidate.runtimeInstanceId === runtimeInstanceId || candidate.legacyAgentInstanceId === runtimeInstanceId);
    if (!item) throw new NotFoundException('runtime instance not found');
    return { schemaVersion: 'anysentry.runtime_instance.v1', item, revision: result.revision, coverage: result.coverage, dataSource: result.dataSource, updateTime: new Date().toISOString() };
  }

  @Get('v1/sessions')
  @RequireManagementAuth()
  async canonicalSessions(@Query() rawQuery: Record<string, unknown>, @Headers() headers: HeaderBag): Promise<T.CanonicalSessionList> {
    const query = parseCanonicalEntityQuery(rawQuery);
    const result = await this.canonicalSessionResources(query, headers);
    const page = canonicalPage(result.items, query);
    this.audit.record({ actor: auditActor(headers), action: 'agent.conversation.content.list', resourceType: 'agent', resourceId: 'session-collection', summary: `Read ${page.items.length} canonical Session resource(s)`, details: { total: page.total, revision: result.revision } });
    return { schemaVersion: 'anysentry.session.list.v1', ...page, revision: result.revision, coverage: query.includeCoverage ? result.coverage : canonicalCoverage(false, [], result.dataSource), dataSource: result.dataSource, updateTime: new Date().toISOString() };
  }

  @Get('v1/sessions/:sessionId')
  @RequireManagementAuth()
  async canonicalSession(@Param('sessionId') sessionId: string, @Query() rawQuery: Record<string, unknown>, @Headers() headers: HeaderBag) {
    const query = parseCanonicalEntityQuery({ ...rawQuery, sessionId });
    const result = await this.canonicalSessionResources(query, headers);
    const item = result.items.find((candidate) => [candidate.sessionId, candidate.canonicalSessionId, candidate.conversationId].includes(sessionId));
    if (!item) throw new NotFoundException('session not found');
    return { schemaVersion: 'anysentry.session.v1', item, revision: result.revision, coverage: result.coverage, dataSource: result.dataSource, updateTime: new Date().toISOString() };
  }

  @Get('v1/sessions/:sessionId/timeline')
  @RequireManagementAuth()
  async canonicalSessionTimeline(@Param('sessionId') sessionId: string, @Query() rawQuery: Record<string, unknown>, @Headers() headers: HeaderBag) {
    const query = parseCanonicalEntityQuery({ ...rawQuery, sessionId });
    const sessions = await this.canonicalSessionResources({ ...query, offset: 0, limit: 500 }, headers);
    let session = sessions.items.find((candidate) => [candidate.sessionId, candidate.canonicalSessionId, candidate.conversationId].includes(sessionId));
    let conversationId = session?.conversationId ?? session?.sessionId ?? sessionId;
    let timeline: T.AgentConversationTimelineV3 | undefined;
    let timelineDegraded = false;
    let sessionDegraded = false;
    // If the canonical Session projector timed out before materializing a row, use the bounded
    // compatibility conversation projection once. This can recover a valid session/thread from
    // ClickHouse/hot interactions without scanning the whole history; a missing result under a
    // partial projection is reported as unavailable rather than a misleading 404.
    if (!session && sessions.coverage.status !== 'complete') {
      try {
        timeline = await withCanonicalProjectionTimeout(this.agg.agentConversationTimelineV3({
          timeType: query.timeType,
          startTime: query.startTime,
          endTime: query.endTime,
          snapshotAsOf: query.snapshotAsOf,
          scope: 'raw',
          classificationView: query.classificationView,
          conversationId: sessionId,
          limit: query.limit,
        }), CANONICAL_SEMANTIC_TIMELINE_TIMEOUT_MS);
        if (timeline.thread) {
          session = canonicalSessionResourceFromSummary(
            timeline.thread,
            sessions.revision,
          );
          conversationId = session.conversationId ?? session.sessionId;
          sessionDegraded = true;
        }
      } catch (error) {
        if (!isCanonicalProjectionDegradation(error)) throw error;
        sessionDegraded = true;
      }
    }
    if (!session) {
      if (sessions.coverage.status !== 'complete' || sessionDegraded) {
        throw new ServiceUnavailableException('Canonical session projection is unavailable');
      }
      throw new NotFoundException('session not found');
    }
    conversationId = session.conversationId ?? session.sessionId;
    try {
      timeline ??= await withCanonicalProjectionTimeout(this.agg.agentConversationTimelineV3({
        timeType: query.timeType,
        startTime: query.startTime,
        endTime: query.endTime,
        snapshotAsOf: query.snapshotAsOf,
        scope: 'raw',
        classificationView: query.classificationView,
        conversationId,
        limit: query.limit,
      }), CANONICAL_SEMANTIC_TIMELINE_TIMEOUT_MS);
    } catch (error) {
      if (!isCanonicalProjectionDegradation(error)) throw error;
      timelineDegraded = true;
      timeline = degradedCanonicalTimeline(conversationId, query, sessions.revision);
    }
    const coverage = timelineDegraded
      ? canonicalCoverage(true, [
          ...sessions.coverage.reasons,
          'session_timeline_projection_timeout',
        ], `${sessions.dataSource}+session_timeline`)
      : sessionDegraded
        ? canonicalCoverage(true, [
            ...sessions.coverage.reasons,
            'canonical_session_projection_unavailable',
          ], `${sessions.dataSource}+session_timeline`)
        : sessions.coverage;
    return { schemaVersion: 'anysentry.session.timeline.v1', session, timeline, revision: sessions.revision, coverage, dataSource: sessions.dataSource, updateTime: new Date().toISOString() };
  }

  @Get('v1/sessions/:sessionId/coverage')
  @RequireManagementAuth()
  async canonicalSessionCoverage(@Param('sessionId') sessionId: string, @Query() rawQuery: Record<string, unknown>, @Headers() headers: HeaderBag) {
    const query = parseCanonicalEntityQuery({ ...rawQuery, sessionId });
    const result = await this.canonicalSessionResources({ ...query, offset: 0, limit: 500 }, headers);
    const session = result.items.find((candidate) => [candidate.sessionId, candidate.canonicalSessionId, candidate.conversationId].includes(sessionId));
    if (!session) throw new NotFoundException('session not found');
    return { schemaVersion: 'anysentry.session.coverage.v1', sessionId: session.sessionId, coverage: session.coverage, revision: result.revision, dataSource: result.dataSource, updateTime: new Date().toISOString() };
  }

  @Get('v1/semantic-events/:semanticEventId/evidence')
  @RequireManagementAuth()
  async canonicalSemanticEventEvidence(
    @Param('semanticEventId') semanticEventId: string,
    @Query() rawQuery: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<T.CanonicalSemanticEventEvidenceResponse> {
    const id = strictIdentityText(semanticEventId, 512);
    if (!id) throw new BadRequestException('semanticEventId is invalid');
    const query = parseCanonicalEntityQuery(rawQuery);
    const timelineId = id.startsWith('se_');
    const durableId = id.startsWith('sr_');
    // `se_…` is a deterministic read-time timeline identifier, not a durable SemanticRecord key.
    // Do not issue a PostgreSQL side-lane lookup for it: under storage pressure that pointless
    // query can consume the entire projection timeout before the compatibility timeline path has
    // a chance to resolve the deep link. Durable `sr_…` identifiers still use the authoritative
    // revision-aware lookup below.
    let semanticRecord: SemanticRecord | undefined;
    let semanticRecordUnavailable = false;
    if (durableId) {
      const resolved = await this.boundedCanonicalPoint(
        this.canonicalObservability.getDurableSemanticRecord(id, query.revision),
        () => this.canonicalObservability.semantic.get(id, query.revision),
      );
      semanticRecord = resolved.value;
      semanticRecordUnavailable = resolved.degraded && !semanticRecord;
    }
    // Keep the old 404 behavior for a syntactically unrelated identifier, but do not report a
    // false 404 for a valid canonical id whose projection has expired or is still ambiguous.
    if (!semanticRecord && !timelineId && !durableId) {
      throw new NotFoundException('semantic record not found');
    }

    let sessions: CanonicalSessionProjection;
    let timelineSearch: CanonicalSemanticTimelineSearch | undefined;
    // A scoped deep link can be resolved directly from the bounded compatibility interaction
    // projection. This avoids scanning hundreds of canonical Session rows when PostgreSQL's
    // membership projector is behind, while retaining the session-scan fallback for unscoped or
    // older identifiers.
    if (query.agentAssetId || query.agentInstanceId) {
      try {
        timelineSearch = await withCanonicalProjectionTimeout(
          this.legacySemanticTimelineCandidates(id, semanticRecord, query),
          CANONICAL_SEMANTIC_TIMELINE_TIMEOUT_MS,
        );
      } catch (error) {
        if (!isCanonicalProjectionDegradation(error)) throw error;
        timelineSearch = {
          candidates: [],
          scanned: 0,
          truncated: true,
          failed: 1,
        };
      }
    }
    // The direct compatibility path carries a complete bounded Session summary for the matched
    // interaction. Reuse it as the read scope instead of waiting on the broad canonical session
    // projector; this keeps a valid deep link responsive while PostgreSQL catches up.
    if (timelineSearch?.candidates.length) {
      const directSessions = [...new Map(timelineSearch.candidates.map((candidate) => [
        candidate.session.sessionId,
        candidate.session,
      ])).values()];
      sessions = {
        items: directSessions,
        coverage: canonicalCoverage(
          directSessions.some((session) => session.coverage.status !== 'complete'),
          directSessions.flatMap((session) => session.coverage.reasons),
          'compatibility_interaction_projection',
        ),
        dataSource: 'compatibility_interaction_projection',
        revision: this.canonicalCurrentRevision(),
      };
    } else {
      sessions = await this.canonicalSessionResources({ ...query, offset: 0, limit: 500 }, headers);
    }
    if (!timelineSearch || timelineSearch.candidates.length === 0) {
      try {
        timelineSearch = await withCanonicalProjectionTimeout(
          this.canonicalSemanticTimelineCandidates(
            id,
            semanticRecord,
            query,
            sessions.items,
          ),
          CANONICAL_SEMANTIC_TIMELINE_TIMEOUT_MS,
        );
      } catch (error) {
        if (!isCanonicalProjectionDegradation(error)) throw error;
        // A slow per-session timeline must not make a canonical inspector hang for every candidate.
        // Keep the durable semantic row (when present) and return an explicit bounded gap; a later
        // request can retry after the projection catches up.
        timelineSearch = {
          candidates: [],
          scanned: Math.min(sessions.items.length, CANONICAL_SEMANTIC_SESSION_SCAN_MAX),
          truncated: true,
          failed: 1,
        };
      }
    }
    timelineSearch ??= {
      candidates: [],
      scanned: 0,
      truncated: true,
      failed: 1,
    };
    const uniqueTimelineCandidates = [...new Map(timelineSearch.candidates.map((candidate) => [
      `${candidate.session.sessionId}\u0000${candidate.event.semanticEventId}`,
      candidate,
    ])).values()];
    // If the bounded search was truncated, do not force a single candidate: an unseen session
    // may contain the same stable event id. The response remains queryable with coverage metadata.
    const timelineAmbiguous = uniqueTimelineCandidates.length > 1
      || (timelineSearch.truncated && timelineSearch.exactUnique !== true);
    const selected = uniqueTimelineCandidates.length === 1
      && (!timelineSearch.truncated || timelineSearch.exactUnique === true)
      ? uniqueTimelineCandidates[0]
      : undefined;

    // A timeline event can be retained after the durable semantic row expires.  Conversely, a
    // durable `sr_` row can outlive the conversation projection. Search the bounded durable lane
    // for the latter case only; `se_` already has a stable interaction-derived identity and a
    // full 10k-row alias scan would make a working deep link depend on a slow side store.
    let aliasRecords: SemanticRecord[] = semanticRecord ? [semanticRecord] : [];
    let aliasLookupUnavailable = false;
    if (!semanticRecord && selected) {
      // A timeline event can be retained after the durable semantic row expires.  Keep the alias
      // contract, but bound the optional lookup sharply: `se_…` already identifies the selected
      // interaction and must not wait for a 10k-row PostgreSQL scan under storage pressure.  The
      // durable `sr_…`-outlives-timeline case keeps the wider compatibility budget.
      try {
        const aliasLimit = timelineId ? 128 : 10_000;
        aliasRecords = await withCanonicalProjectionTimeout(
          this.canonicalObservability.listDurableSemanticRecords(aliasLimit),
          timelineId ? CANONICAL_SEMANTIC_ALIAS_TIMEOUT_MS : CANONICAL_SEMANTIC_EVIDENCE_TIMEOUT_MS,
        ).then((records) => records.filter((candidate) =>
          canonicalSemanticRecordTouchesEvent(candidate, selected.event)));
      } catch (error) {
        if (!isCanonicalProjectionDegradation(error)) throw error;
        aliasLookupUnavailable = true;
        aliasRecords = [];
      }
    }
    const aliasAmbiguous = aliasRecords.length > 1;
    const resolvedSemanticRecord = aliasRecords.length === 1 ? aliasRecords[0] : semanticRecord;
    let evidence: T.AgentSemanticEvidenceResponse | undefined;
    let evidenceFailureReason: 'semantic_evidence_projection_unavailable' | 'semantic_evidence_projection_failed' | undefined;
    if (selected && !timelineAmbiguous && selected.event.actor === 'tool') {
      try {
        // The legacy evidence projector is authoritative for relation revisions and canonical
        // EvidenceLink decoration; always pass the resolved timeline (`se_`) id to it.
        evidence = await withCanonicalProjectionTimeout(this.agentSemanticEvidence({
          timeType: query.timeType,
          startTime: query.startTime,
          endTime: query.endTime,
          snapshotAsOf: query.snapshotAsOf,
          scope: 'raw',
          classificationView: query.classificationView,
          conversationId: selected.session.conversationId ?? selected.session.sessionId,
          semanticEventId: selected.event.semanticEventId,
        }, headers), CANONICAL_SEMANTIC_EVIDENCE_TIMEOUT_MS);
      } catch (error) {
        if (!isCanonicalProjectionDegradation(error)) throw error;
        evidenceFailureReason = error instanceof NotFoundException
          ? 'semantic_evidence_projection_unavailable'
          : 'semantic_evidence_projection_failed';
        // A valid timeline event without a materialized relation is a coverage gap, not a bad
        // identifier.  Keep the requested/alias ids in the response for later replay.
      }
    }

    const reasons = [...sessions.coverage.reasons];
    if (!selected) reasons.push('semantic_timeline_projection_unavailable');
    if (timelineAmbiguous) reasons.push('semantic_timeline_identifier_ambiguous');
    if (timelineSearch.truncated) reasons.push('semantic_timeline_scan_bound');
    if (timelineSearch.failed > 0) reasons.push('semantic_timeline_projection_failed');
    if (aliasAmbiguous) reasons.push('durable_semantic_identifier_ambiguous');
    if (aliasLookupUnavailable) reasons.push('durable_semantic_alias_unavailable');
    if (semanticRecordUnavailable) reasons.push('durable_semantic_record_projection_unavailable');
    if (selected && selected.event.actor !== 'tool') reasons.push('semantic_event_not_tool');
    if (selected && selected.event.actor === 'tool' && !evidence) reasons.push('semantic_evidence_projection_unavailable');
    if (evidenceFailureReason) reasons.push(evidenceFailureReason);
    if (!resolvedSemanticRecord && durableId) reasons.push('durable_semantic_record_unavailable');
    const coverage = canonicalScopeCoverage(query, canonicalCoverage(
      sessions.coverage.status !== 'complete' || reasons.length > 0,
      reasons,
      `${sessions.dataSource}+semantic_timeline`,
    ), false);
    const aliasCandidates = [
      ...uniqueTimelineCandidates.map((candidate) => candidate.event.semanticEventId),
      ...aliasRecords.map((candidate) => candidate.semanticRecordId),
    ].filter((candidate, index, all) => all.indexOf(candidate) === index).slice(0, 64);
    const relationStatus: T.CanonicalSemanticEventEvidenceResponse['relationStatus'] = timelineAmbiguous || aliasAmbiguous
      ? 'ambiguous'
      : evidence?.relationStatus ?? 'coverage_gap';
    return {
      schemaVersion: 'anysentry.evidence_link.semantic_event.v1',
      requestedSemanticEventId: id,
      ...(selected ? { resolvedSemanticEventId: selected.event.semanticEventId } : {}),
      ...((id.startsWith('sr_') && selected)
        ? { aliasOf: id }
        : (id.startsWith('se_') && resolvedSemanticRecord)
          ? { aliasOf: resolvedSemanticRecord.semanticRecordId }
          : {}),
      ...((timelineAmbiguous || aliasAmbiguous) && aliasCandidates.length > 0 ? { aliasCandidates } : {}),
      ...(resolvedSemanticRecord ? { semanticRecord: resolvedSemanticRecord } : {}),
      ...(evidence ? { evidence } : {}),
      relationStatus,
      coverage,
      revision: Math.max(
        sessions.revision,
        resolvedSemanticRecord?.resolutionRevision ?? 0,
        this.canonicalCurrentRevision(),
      ),
      dataSource: `${sessions.dataSource}+semantic_timeline`,
      updateTime: new Date().toISOString(),
    };
  }

  @Get('v1/kernel-facts/:factId/context')
  @RequireManagementAuth()
  async canonicalKernelFactContext(@Param('factId') factId: string, @Headers() headers: HeaderBag) {
    const id = strictIdentityText(factId, 240);
    if (!id) throw new BadRequestException('factId is invalid');
    const resolved = await this.canonicalKernelFactWithFallback(id);
    const fact = resolved.fact;
    let context: T.AgentKernelSemanticContextResponse;
    let coverage: T.CanonicalEntityCoverage;
    try {
      context = await withCanonicalProjectionTimeout(
        this.agg.agentKernelSemanticContext(fact.eventId ?? id),
        CANONICAL_STORE_READ_TIMEOUT_MS,
      );
      coverage = canonicalCoverage(false, [], 'relational_semantic_relation_projection');
    } catch (error) {
      if (!isCanonicalProjectionDegradation(error)) throw error;
      // The immutable KernelFact remains authoritative even if the optional relation projector
      // is unavailable. Return an explicit empty context/coverage gap instead of masking the fact
      // behind an HTTP 500 or making the UI retry an unbounded query.
      context = {
        schemaVersion: 'anysentry.agent_kernel_semantic_context.v1',
        eventId: fact.eventId ?? id,
        relations: [],
        conversationLinks: [],
        updateTime: new Date().toISOString(),
      };
      coverage = canonicalCoverage(true, ['kernel_semantic_context_unavailable'], 'relational_semantic_relation_projection');
    }
    return {
      schemaVersion: 'anysentry.kernel_fact.context.v1',
      fact,
      context,
      coverage: resolved.fallback
        ? canonicalCoverage(true, [
            'canonical_kernel_fact_projection_unavailable',
            ...coverage.reasons,
          ], coverage.source)
        : coverage,
      ...(resolved.fallback ? { dataSource: 'compatibility_event_projection' } : {}),
      revision: this.canonicalCurrentRevision(),
      updateTime: new Date().toISOString(),
    };
  }

  @Get('v1/observability/contracts')
  @RequireManagementAuth()
  observabilityContracts() {
    return {
      schemaVersion: 'anysentry.observability_contract_catalog.v1',
      rawObservation: 'anysentry.raw_observation.v1',
      kernelFact: 'anysentry.kernel_fact.v1',
      semanticRecord: 'anysentry.semantic_record.v1',
      logicalAgentDefinition: 'anysentry.logical_agent_definition.v1',
      agentInstance: 'anysentry.agent_instance.v1',
      runtimeInstance: 'anysentry.runtime_instance.v1',
      connectionIdentity: 'anysentry.connection_identity.v1',
      sessionMembership: 'anysentry.session_membership.v1',
      evidenceLink: 'anysentry.evidence_link.v1',
      coverageGap: 'anysentry.coverage_gap.v1',
      relationRevision: 'anysentry.relation_revision.v1',
      registries: this.canonicalObservability.registryCatalog(),
      retention: {
        rawHotTtlMs: this.canonicalObservability.stats().ttlMs,
        bodies: 'hash_only_in_canonical_lane',
        sessionKey: SESSION_KEY_ALGORITHM_V1,
        canonicalSessionId: CANONICAL_SESSION_ID_ALGORITHM_V1,
        sessionHashSecretMode: SESSION_HASH_SECRET_MODE,
        // Deprecated compatibility label retained for older readers; the new field above makes
        // the dedicated-vs-ephemeral distinction explicit without exposing any secret material.
        unconfiguredSecret: 'process_ephemeral',
      },
    };
  }

  /**
   * Process liveness probe. This endpoint must stay O(1) and independent of ClickHouse,
   * PostgreSQL, queues, and projection caches so a storage incident cannot make kubelet restart
   * a healthy process. Readiness may continue to use the richer healthz contract.
   */
  @Get('livez')
  @SkipWrap()
  livez(): { schemaVersion: 'anysentry.livez.v1'; status: 'ok'; service: 'anysentry-api' } {
    return { schemaVersion: 'anysentry.livez.v1', status: 'ok', service: 'anysentry-api' };
  }

  @Get('healthz')
  healthz() {
    const stats = this.judge.healthStats();
    const policy = this.judge.getPolicy();
    return {
      schemaVersion: 'anysentry.health.v1',
      status: 'ok',
      service: 'anysentry-api',
      uptimeSeconds: Math.round(process.uptime()),
      storage: this.judge.storageStatus(),
      businessState: {
        mode: this.relational.configured() ? 'postgresql' : 'clickhouse-migration-fallback',
        postgresqlConfigured: this.relational.configured(),
        postgresqlReady: this.relational.isReady(),
        writerOwnership: this.relational.writerOwnershipStats(),
        agentMetadataHotState: this.agentMetadata.hotStateStats(),
        workspaceDirectory: this.workspaceDirectory.status(),
        incidents: this.judge.incidentStateStatus(),
        alerts: this.alerting.stateStatus(),
        remediations: this.remediation.stateStatus(),
        ingestionSources: this.sources.stateStatus(),
        maintenanceWindows: this.maintenance.stateStatus(),
        notifications: this.notifications.stateStatus(),
        objectives: this.objectives.stateStatus(),
        users: this.users.stateStatus(),
        policyConfig: this.judge.policyStateStatus(),
      },
      managementAuth: {
        enabled: managementAuthConfigured(),
      },
      events: {
        total: stats.total,
        distinctAgents: stats.distinctAgents,
        distinctSessions: stats.distinctSessions,
      },
      historyFactCache: this.agg.historyFactCacheStatus(),
      eventWriteBatch: this.judge.eventWriteBatchStatus(),
      dashboardBucketSnapshots: this.judge.dashboardBucketSnapshotStatus(),
      policy: policy.status,
      streaming: {
        ...this.streaming.status(),
        findingStoreReady: this.streamFindings.enabled,
      },
      supplyChain: {
        enabled: this.supplyChain.enabled,
      },
      canonicalObservability: {
        raw: this.canonicalObservability.stats(),
        kernel: this.canonicalObservability.kernelStats(),
        semantic: this.canonicalObservability.semanticStats(),
        evidence: this.canonicalObservability.evidence.stats(),
        sessionMembership: this.canonicalObservability.sessionMembershipStats(),
        gaps: this.canonicalObservability.gapStats(),
        bindingHotState: this.conversationBindings?.hotStateStats(),
        aggregationCaches: this.agg.cacheStateStats(),
        canonicalDirectoryCache: this.canonicalDirectoryCacheStats(),
        canonicalSessionCache: this.canonicalSessionCacheStats(),
        ingressCaches: ingressCacheStats(),
      },
    };
  }

  @Get('platform/metrics')
  platformMetricsOverview(@Query('range') range?: string): Promise<T.PlatformMetricsOverview> {
    return this.platformMetrics.overview(range);
  }

  @Get('platform/metrics/prometheus')
  @SkipWrap()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  platformMetricsPrometheus(): string {
    return this.platformMetrics.prometheusText();
  }

  /** Versioned, node-filtered workload identity data for observation-only forwarders. */
  @Get('identity/snapshot')
  @SkipWrap()
  identitySnapshot(@Query('nodeName') nodeName?: string): T.WorkloadIdentitySnapshot {
    const platform = this.kube.snapshot(nodeName);
    const reviewed = this.agentMetadata.identitySnapshotEntries(nodeName);
    return {
      ...platform,
      version: platform.version + this.agentMetadata.identitySnapshotVersion(),
      // Manual decisions are ordered first. WorkloadIdentityCache deliberately keeps the first
      // identity for a key, so a reviewer decision overrides an automatic platform candidate.
      entries: [...reviewed, ...platform.entries],
    };
  }

  /** Stable current Service Assets derived from server-owned workload inventory. */
  @Get('services/inventory')
  @SkipWrap()
  serviceInventory(
    @Query('namespace') namespace?: string,
    @Query('role') role?: string,
    @Query('kind') kind?: string,
  ) {
    const snapshot = this.kube.serviceInventory();
    const selectedIds = new Set(snapshot.items
      .filter((item) =>
        (!namespace || item.namespace === namespace) &&
        (!role || item.role === role) &&
        (!kind || item.kind === kind),
      )
      .map((item) => item.serviceAssetId));
    return {
      ...snapshot,
      items: snapshot.items.filter((item) => selectedIds.has(item.serviceAssetId)),
      dependencies: snapshot.dependencies.filter((edge) =>
        selectedIds.has(edge.sourceServiceAssetId) && selectedIds.has(edge.targetServiceAssetId),
      ),
      changes: snapshot.changes.filter((change) => selectedIds.has(change.serviceAssetId)),
    };
  }

  @Get('capabilities')
  securityCapabilitiesGet(@Query() query: T.SecurityCapabilityRequest = {}, @Headers() headers: HeaderBag): unknown {
    const action = securityCapabilityAction(query.action);
    if (action === 'execute') {
      throw new BadRequestException(`action=${action} requires POST /security-center/capabilities`);
    }
    return this.dispatchSecurityCapability(normalizeSecurityCapabilityInput({ ...query, action }), headers);
  }

  @Post('capabilities')
  @HttpCode(200)
  securityCapabilitiesPost(@Body() body: T.SecurityCapabilityRequest = {}, @Headers() headers: HeaderBag): unknown {
    return this.dispatchSecurityCapability(normalizeSecurityCapabilityInput({ ...body, action: securityCapabilityAction(body.action) }), headers);
  }

  private async dispatchSecurityCapability(input: T.SecurityCapabilityRequest, headers: HeaderBag): Promise<unknown> {
    const action = securityCapabilityAction(input.action);
    const shaped = securityCapabilityShaped(input.shaped);
    let result: unknown;
    if (action === 'list') {
      result = securityModules(input);
      return shaped ? securityCapabilityResponse(action, { success: true, modules: result as T.SecurityApiModule[] }) : result;
    }
    if (action === 'search') {
      result = securityCapabilitySearch(input.query);
      return shaped ? securityCapabilityResponse(action, { success: true, operations: result as T.SecurityApiOperation[] }) : result;
    }
    if (action === 'describe') {
      const module = findSecurityModule(input.module ?? input.query);
      result = input.operation ? findSecurityOperation(module, input.operation) : module;
      return shaped
        ? securityCapabilityResponse(action, input.operation ? { success: true, operation: result as T.SecurityApiOperation } : { success: true, module: result as T.SecurityApiModule })
        : result;
    }
    result = await this.executeSecurityCapability(input, headers);
    return shaped
      ? securityCapabilityResponse(action, {
          success: true,
          data: result,
          result,
          module: findSecurityModule(input.module),
          operation: findSecurityOperation(findSecurityModule(input.module), input.operation),
        })
      : result;
  }

  private async executeSecurityCapability(input: T.SecurityCapabilityRequest, headers: HeaderBag): Promise<unknown> {
    const module = findSecurityModule(input.module);
    const operation = findSecurityOperation(module, input.operation);
    if (input.dryRun) {
      const schemaIssues = validateSecurityCapabilitySchema(obj(operation.inputSchema)?.body, input);
      const schemaValid = schemaIssues.every((issue) => issue.severity !== 'error');
      const normalizedRequest: T.SecurityCapabilityDryRunResult['normalizedRequest'] = {
        action: 'execute',
        module: module.name,
        operation: operation.name,
        dryRun: true,
        params: obj(input.params) ?? {},
        ...(input.constraints ? { constraints: input.constraints } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.shaped !== undefined ? { shaped: input.shaped } : {}),
      };
      return {
        schemaVersion: 'anysentry.progressive.dry_run.v1',
        valid: schemaValid,
        dryRun: true,
        module: module.name,
        operation: operation.name,
        targetInScope: schemaValid,
        tokenVerified: Boolean(headerValue(headers, 'x-anysentry-ingest-token') || bearerToken(headers)),
        decision: schemaValid ? 'allow' : 'reject',
        constraints: input.constraints ?? {},
        schemaValid,
        schemaIssues,
        normalizedRequest,
      } satisfies T.SecurityCapabilityDryRunResult;
    }
    if (module.name === SECURITY_PROGRESSIVE_MODULE && operation.name === 'assessRuntimeAction') {
      return this.executeRuntimeGuardCapability(input, headers);
    }
    if (module.name === SECURITY_PROGRESSIVE_MODULE && operation.name === 'recordSecurityEvents') {
      const params = obj(input.params);
      if (!params) throw new BadRequestException('params object is required for security-center.recordSecurityEvents');
      return this.ingestUniversalEvents(params as T.UniversalIngestRequest, headers, 'custom', 'capabilities:security-center.recordSecurityEvents');
    }
    if (module.name === SECURITY_PROGRESSIVE_MODULE && operation.name === 'buildEvidenceBundle') {
      return this.evidenceBundle((obj(input.params) ?? {}) as T.EvidenceBundleQuery);
    }
    if (module.name === SECURITY_PROGRESSIVE_MODULE && operation.name === 'planNextActions') {
      return this.executeNextActionsCapability(input);
    }
    throw new NotFoundException(`No executor for ${module.name}.${operation.name}`);
  }

  private executeNextActionsCapability(input: T.SecurityCapabilityRequest): T.SecurityNextActionPlan {
    const params = securityNextActionPlanParams(input.params);
    const maxActions = Math.max(1, Math.min(20, Math.round(finiteNumber(params.maxActions) ?? finiteNumber(params.limit) ?? 5)));
    const owner = cleanString(params.owner, 120);
    const list = this.remediation.list({
      ...params,
      status: params.status ?? 'all',
      limit: Math.max(maxActions * 4, 40),
    });
    const statusPinned = Boolean(params.status && params.status !== 'all');
    const candidates = list.items
      .filter((task) => statusPinned || (task.status !== 'done' && task.status !== 'dismissed'))
      .filter((task) => !owner || task.owner === owner)
      .sort((a, b) => {
        const aDue = parseIsoish(a.dueAt) ?? Number.POSITIVE_INFINITY;
        const bDue = parseIsoish(b.dueAt) ?? Number.POSITIVE_INFINITY;
        return (
          NEXT_ACTION_SEVERITY_RANK[b.severity] - NEXT_ACTION_SEVERITY_RANK[a.severity] ||
          NEXT_ACTION_STATUS_RANK[b.status] - NEXT_ACTION_STATUS_RANK[a.status] ||
          aDue - bDue ||
          a.title.localeCompare(b.title)
        );
      });
    const actions = candidates
      .slice(0, maxActions)
      .map((task, index) => nextActionPlanItem(task, index + 1, params.includeCompletedSteps === true));
    return {
      schemaVersion: 'anysentry.progressive.next_action_plan.v1',
      module: SECURITY_PROGRESSIVE_MODULE,
      operation: 'planNextActions',
      generatedAt: new Date().toISOString(),
      scope: {
        timeType: params.timeType,
        workspacePath: cleanString(params.workspacePath, 500),
        agentId: cleanString(params.agentId, 240),
        collectorId: cleanString(params.collectorId, 180),
        sourceId: cleanString(params.sourceId, 180),
        owner,
        q: cleanString(params.q, 200),
      },
      summary: {
        totalCandidates: candidates.length,
        returnedActions: actions.length,
        criticalActions: actions.filter((action) => action.priority === 'critical').length,
        overdueActions: actions.filter((action) => action.overdue).length,
        approvalRequiredActions: actions.filter((action) => action.needsApproval).length,
      },
      actions,
    };
  }

  private async executeRuntimeGuardCapability(input: T.SecurityCapabilityRequest, headers: HeaderBag): Promise<T.SecurityRuntimeGuardDecision> {
    const body = securityRuntimeGuardParams(input.params);
    const autonomy = securityCapabilityAutonomy(body.autonomy ?? input.constraints?.autonomy);
    const stage = securityCapabilityStage(body.stage);
    const event = securityRuntimeGuardEvent(body, autonomy, stage);
    const result = await this.ingestUniversalEvents(
      {
        workspacePath: body.workspacePath,
        agentId: body.agentId,
        sessionId: body.sessionId,
        userId: body.userId,
        traceId: body.traceId,
        spanId: body.spanId,
        parentSpanId: body.parentSpanId,
        runId: body.runId,
        taskId: body.taskId,
        sourceName: body.sourceName ?? 'progressive-security-runtime-client',
        sourceType: 'custom',
        sourceId: body.sourceId,
        token: body.token,
        collectorId: body.collectorId,
        events: [event],
      },
      headers,
      'custom',
      'capabilities:security-center.assessRuntimeAction',
      'sync',
    );
    const item = result.items[0];
    const fallbackRisk = securityRuntimeGuardFallbackRisk(body, event);
    const basePolicyAction = securityCapabilityPolicyAction(autonomy, item);
    const policyAction = securityCapabilityPolicyAction(autonomy, item, fallbackRisk);
    let evidenceItem = item;
    if (fallbackRisk && policyActionRank(policyAction) > policyActionRank(basePolicyAction)) {
      const finding = await this.ingestUniversalEvents(
        {
          workspacePath: body.workspacePath,
          agentId: body.agentId,
          sessionId: body.sessionId,
          userId: body.userId,
          traceId: body.traceId,
          spanId: body.spanId,
          parentSpanId: body.parentSpanId,
          runId: body.runId,
          taskId: body.taskId,
          sourceName: body.sourceName ?? 'progressive-security-runtime-client',
          sourceType: 'custom',
          sourceId: body.sourceId,
          token: body.token,
          collectorId: body.collectorId,
          events: [securityRuntimeGuardFallbackEvent(body, event, fallbackRisk, autonomy, stage, item?.eventId, item?.traceId, item?.spanId)],
        },
        headers,
        'custom',
        'capabilities:security-center.assessRuntimeAction.fallback',
        'sync',
      );
      evidenceItem = finding.items.find((candidate) => candidate.accepted) ?? evidenceItem;
    }
    const decision: T.SecurityRuntimeGuardDecision = {
      schemaVersion: 'anysentry.progressive.runtime_guard.result.v1',
      module: SECURITY_PROGRESSIVE_MODULE,
      operation: 'assessRuntimeAction',
      capabilityId: 'security.runtimeGuard',
      autonomy,
      stage,
      policyAction,
      recommendedAction: securityCapabilityRecommendedAction(policyAction),
      accepted: result.accepted,
      sourceId: result.sourceId,
      eventId: evidenceItem?.eventId,
      traceId: evidenceItem?.traceId ?? item?.traceId,
      runId: evidenceItem?.runId ?? item?.runId,
      verdict: evidenceItem?.verdict ?? item?.verdict,
      tier: evidenceItem?.tier ?? item?.tier,
      severity: fallbackRisk?.severity ?? evidenceItem?.severity ?? item?.severity,
      riskCategory: fallbackRisk?.riskCategory ?? evidenceItem?.riskCategory ?? item?.riskCategory,
      reason: fallbackRisk?.reason ?? evidenceItem?.reason ?? item?.reason,
      evidence: {
        eventId: evidenceItem?.eventId,
        eventsHref: evidenceItem?.eventId ? `/events?eventId=${encodeURIComponent(evidenceItem.eventId)}` : undefined,
        bundleHint: evidenceItem?.eventId ? { eventId: evidenceItem.eventId } : undefined,
      },
    };
    return decision;
  }

  /** Generic JSON event ingress for webhooks, OTel bridges, and custom producers. */
  @Post('ingest/events')
  ingestEvents(@Body() body: T.UniversalIngestBody = {}, @Headers() headers: HeaderBag): Promise<T.UniversalIngestResult> {
    const normalized = normalizeUniversalIngestBody(body, headers);
    return this.ingestUniversalEvents(normalized, headers, normalized.sourceType ?? 'custom', 'ingest/events');
  }

  /** Native OTLP/HTTP JSON ingress: accepts resourceLogs/resourceSpans and normalizes them. */
  @Post('ingest/otel')
  ingestOtel(@Body() body: T.UniversalIngestRequest & Record<string, unknown> = {}, @Headers() headers: HeaderBag): Promise<T.UniversalIngestResult> {
    return this.ingestUniversalEvents(otlpToUniversal(body), headers, 'otel', 'ingest/otel');
  }

  /** OTLP/HTTP logs endpoint shape: set exporter base URL to /security-center/ingest/otlp. */
  @Post('ingest/otlp/v1/logs')
  ingestOtlpLogs(@Body() body: T.UniversalIngestRequest & Record<string, unknown> = {}, @Headers() headers: HeaderBag): Promise<T.UniversalIngestResult> {
    return this.ingestUniversalEvents(otlpToUniversal(body), headers, 'otel', 'ingest/otlp/v1/logs');
  }

  /** OTLP/HTTP traces endpoint shape: set exporter base URL to /security-center/ingest/otlp. */
  @Post('ingest/otlp/v1/traces')
  ingestOtlpTraces(@Body() body: T.UniversalIngestRequest & Record<string, unknown> = {}, @Headers() headers: HeaderBag): Promise<T.UniversalIngestResult> {
    return this.ingestUniversalEvents(otlpToUniversal(body), headers, 'otel', 'ingest/otlp/v1/traces');
  }

  /** OTLP/HTTP metrics endpoint: normalized facts enter the bounded System Context data plane. */
  @Post('ingest/otlp/v1/metrics')
  ingestOtlpMetrics(@Body() body: T.UniversalIngestRequest & Record<string, unknown> = {}, @Headers() headers: HeaderBag): Promise<T.UniversalIngestResult> {
    return this.ingestUniversalEvents(
      otlpMetricsToUniversal(body),
      headers,
      'otel',
      'ingest/otlp/v1/metrics',
    );
  }

  private async ingestUniversalEvents(body: T.UniversalIngestRequest, headers: HeaderBag, fallbackType: T.IngestionSourceType, endpoint: string, judgeMode: 'async' | 'sync' = 'async'): Promise<T.UniversalIngestResult> {
    const events = universalEvents(body);
    if (!events.length) {
      return { accepted: false, acceptedEvents: 0, rejectedEvents: 0, items: [] };
    }
    const requestSourceId = body.sourceId ?? headerValue(headers, 'x-anysentry-source-id');
    const requestToken = body.token ?? headerValue(headers, 'x-anysentry-ingest-token') ?? bearerToken(headers);
    const requestSourceType = body.sourceType ?? fallbackType;
    const sourceResolution = this.sources.resolve({
      sourceId: requestSourceId,
      token: requestToken,
      collectorId: body.collectorId,
      workspacePath: body.workspacePath,
      sourceName: body.sourceName,
      type: requestSourceType,
      correlationClaim: universalCorrelationClaimForResolve(events[0], body),
    });
    if (!sourceResolution.accepted) {
      const reason = sourceResolution.reason ?? 'source rejected';
      this.recordRejectedIngest(sourceResolution, reason, {
        sourceId: requestSourceId,
        sourceName: body.sourceName,
        sourceType: requestSourceType,
        collectorId: body.collectorId,
        workspacePath: body.workspacePath,
        endpoint,
        rejectedEvents: events.length,
      });
      return {
        accepted: false,
        sourceId: sourceResolution.source?.sourceId,
        acceptedEvents: 0,
        rejectedEvents: events.length,
        items: events.map((_, index) => ({ index, accepted: false, reason })),
      };
    }

    const defaults: T.UniversalIngestRequest = {
      ...body,
      workspacePath: body.workspacePath ?? sourceResolution.source?.workspacePath,
      collectorId: body.collectorId ?? sourceResolution.source?.collectorId,
    };
    const {
      token: _idempotencyToken,
      event: _idempotencyEvent,
      events: _idempotencyEvents,
      ...idempotencyDefaults
    } = defaults;
    const idempotencySource = sourceResolution.authenticated
      ? sourceResolution.source?.sourceId ?? requestSourceId
      : undefined;
    const items: T.UniversalIngestResultItem[] = [];
    let acceptedEvents = 0;
    for (let index = 0; index < events.length; index += 1) {
      const input = events[index];
      const inputCollectorId = universalEventCollectorId(input, defaults);
      const inputWorkspacePath = cleanString(input.workspacePath ?? defaults.workspacePath, 500);
      if (input.attributes?.invalidBatchItem === true) {
        const reason = 'invalid batch item';
        this.recordRejectedIngest(sourceResolution, reason, {
          sourceId: requestSourceId,
          sourceName: body.sourceName,
          sourceType: requestSourceType,
          collectorId: inputCollectorId,
          workspacePath: inputWorkspacePath,
          endpoint,
          rejectedEvents: 1,
        });
        items.push({ index, accepted: false, reason });
        continue;
      }
      if (input.attributes?.invalidCloudEventDataBase64 === true) {
        const reason = 'invalid CloudEvents data_base64';
        this.recordRejectedIngest(sourceResolution, reason, {
          sourceId: requestSourceId,
          sourceName: body.sourceName,
          sourceType: requestSourceType,
          collectorId: inputCollectorId,
          workspacePath: inputWorkspacePath,
          endpoint,
          rejectedEvents: 1,
        });
        items.push({ index, accepted: false, reason });
        continue;
      }
      const producerEventId = cleanString(input.id, 240);
      const producerEventKey = idempotencySource && producerEventId
        ? `${idempotencySource}\0${producerEventId}`
        : '';
      const producerEventDigest = producerEventKey
        ? safePayloadDigest({ defaults: idempotencyDefaults, event: input })
        : '';
      const replay = producerEventKey
        ? universalEventReplay(producerEventKey, producerEventDigest)
        : undefined;
      if (replay?.item) {
        acceptedEvents += replay.item.accepted ? 1 : 0;
        items.push({ ...replay.item, index, duplicate: true });
        continue;
      }
      if (replay?.conflict) {
        const reason = 'producer event id is already bound to a different payload';
        if (events.length === 1) throw new ConflictException(reason);
        this.recordRejectedIngest(sourceResolution, reason, {
          sourceId: requestSourceId,
          sourceName: body.sourceName,
          sourceType: requestSourceType,
          collectorId: universalEventCollectorId(input, defaults),
          workspacePath: cleanString(input.workspacePath ?? defaults.workspacePath, 500),
          endpoint,
          rejectedEvents: 1,
        });
        items.push({
          index,
          accepted: false,
          disposition: 'rejected',
          reasonCode: 'producer_event_id_conflict',
          reason,
        });
        continue;
      }
      const kind = canonicalEventKind(input);
      const adapterPolicy = sourceResolution.source?.correlationClaims;
      // A trusted Adapter owns the complete semantic trace, not only the two span kinds that
      // happen to carry an explicit tool.  Apply the same server-side identity/correlation gate
      // to LlmApi, WorkflowNode, User/Model messages and ToolResult so one run cannot fragment
      // into a confirmed Tool span plus unassigned model/node spans.  The policy remains the
      // authority boundary; generic OTLP sources without it are not promoted.
      const semanticAgentEvent = isSemanticUniversalEventKind(kind);
      const authenticatedSemanticAdapter = semanticAgentEvent
        && sourceResolution.authenticated
        && adapterPolicy?.enabled === true
        && adapterPolicy.authority === 'agent_adapter';
      if (producerEventKey && authenticatedSemanticAdapter) {
        const durableEventId = this.judge.eventIdForSource(idempotencySource!, producerEventId!);
        const hasStableProducerTime = input.at !== undefined
          || input.timestamp !== undefined
          || eventAttr(input, 'timestamp') !== undefined;
        const durableEventAt = hasStableProducerTime ? eventTime(input) : undefined;
        let durable = this.judge.findEvent(durableEventId);
        if (!durable && this.judge.storageStatus().clickhouseReady) {
          try {
            durable = await this.judge.storedEventById(durableEventId, durableEventAt);
          } catch {
            // Storage health and the subsequent durable insert retain their existing fail-closed
            // behavior. A lookup outage must not turn an unauthenticated claim into acceptance.
          }
        }
        if (durable) {
          const durableDigest = typeof durable.attributes?.['anysentry.producer.payload_sha256'] === 'string'
            ? durable.attributes['anysentry.producer.payload_sha256']
            : undefined;
          if (durableDigest !== producerEventDigest) {
            const reason = 'producer event id is already bound to a different durable payload';
            if (events.length === 1) throw new ConflictException(reason);
            this.recordRejectedIngest(sourceResolution, reason, {
              sourceId: requestSourceId,
              sourceName: body.sourceName,
              sourceType: requestSourceType,
              collectorId: universalEventCollectorId(input, defaults),
              workspacePath: cleanString(input.workspacePath ?? defaults.workspacePath, 500),
              endpoint,
              rejectedEvents: 1,
            });
            items.push({
              index,
              accepted: false,
              disposition: 'rejected',
              reasonCode: 'producer_event_id_conflict',
              reason,
            });
            continue;
          }
          const resultItem = universalAcceptedResultItem(index, durable, true);
          acceptedEvents += 1;
          items.push(resultItem);
          rememberUniversalEvent(producerEventKey, producerEventDigest, resultItem);
          continue;
        }
      }
      if (kind === 'SystemContext' && !isTrustedSystemContextProducer(sourceResolution, inputWorkspacePath)) {
        const reason = 'SystemContext requires an authenticated, workspace-bound managed Source tagged system-context';
        this.recordRejectedIngest(sourceResolution, reason, {
          sourceId: requestSourceId,
          sourceName: body.sourceName,
          sourceType: requestSourceType,
          collectorId: inputCollectorId,
          workspacePath: inputWorkspacePath,
          endpoint,
          rejectedEvents: 1,
        });
        items.push({ index, accepted: false, reason });
        continue;
      }
      const line = universalEventLine(kind, input, defaults);
      const partial = universalMeta(input, defaults, sourceResolution.source?.sourceId);
      const canonicalSourceEventId = partial.sourceEventId
        ?? `universal-${Date.now()}-${process.pid}-${universalCanonicalSequence += 1}-${index}`;
      const derived = deriveMeta(line, {
        ...partial,
        eventKind: kind,
        eventCategory: partial.eventCategory ?? eventCategory(kind),
      });
      const hasProducerTime = input.at !== undefined || input.timestamp !== undefined || eventAttr(input, 'timestamp') !== undefined;
      const candidateObservedAt = hasProducerTime ? eventTime(input) : undefined;
      const observedAt = sourceResolution.authenticated
        && candidateObservedAt !== undefined
        && Number.isFinite(candidateObservedAt)
        && candidateObservedAt >= Date.UTC(2000, 0, 1)
        && candidateObservedAt <= Date.now() + 5 * 60_000
        ? candidateObservedAt : undefined;
      const judgedAt = observedAt ?? Date.now();
      const timedDerived: T.EventMeta = {
        ...derived,
        ...(observedAt === undefined ? {
          eventAtUnixNs: undefined,
          receivedAtUnixNs: undefined,
          eventTimeQuality: 'api_received' as const,
        } : {
          eventAtUnixNs: String(BigInt(Math.trunc(observedAt)) * 1_000_000n),
          receivedAtUnixNs: String(BigInt(Math.max(Math.trunc(observedAt), Date.now())) * 1_000_000n),
          eventTimeQuality: 'producer_supplied' as const,
        }),
        ...(producerEventKey && authenticatedSemanticAdapter ? {
          attributes: {
            ...(derived.attributes ?? {}),
            'anysentry.producer.payload_sha256': producerEventDigest,
          },
        } : {}),
        receivedAt: Date.now(),
        eventTimeQuality: observedAt !== undefined && hasProducerTime ? 'producer_supplied' : 'api_received',
      };
      const reviewed = kind === 'SystemContext'
        ? {
            ...timedDerived,
            attribution: {
              monitored: false,
              classification: 'non_agent' as const,
              confidence: 1,
              reason: 'not_agent' as const,
              source: 'self_register' as const,
              evidence: ['server:authenticated-system-context-source'],
            },
          }
        : this.agentMetadata.applyReview(timedDerived, observedAt);
      const authenticatedSemanticAdapterForEvent = semanticAgentEvent && authenticatedSemanticAdapter;
      const serverEnrichment = authenticatedSemanticAdapter
        ? this.kube.enrichAuthenticatedAgentSemantic(
            reviewed,
            adapterPolicy.bindings.agentScopeIds,
          )
        : { meta: reviewed, inventoryObserved: false, reason: undefined };
      const semanticResolved = authenticatedSemanticAdapterForEvent && !serverEnrichment.inventoryObserved
        ? {
            ...serverEnrichment.meta,
            classificationSemantics: {
              schemaVersion: 'anysentry.classification_semantics.v1' as const,
              identityClassification: 'unknown' as const,
              workloadRole: 'unknown' as const,
              captureProfile: 'unknown_discovery' as const,
              unknownReason: 'unsupported_agent_adapter' as const,
            },
            attribution: {
              monitored: false,
              classification: 'unknown' as const,
              confidence: 0,
              reason: 'hint_only' as const,
              source: 'self_register' as const,
              evidence: [
                'server:authenticated-agent-adapter',
                `server:inventory-merge=${serverEnrichment.reason ?? 'unavailable'}`,
              ],
            },
          }
        : serverEnrichment.meta;
      const serverReviewed = serverEnrichment.inventoryObserved
        ? this.agentMetadata.applyReview(semanticResolved, observedAt)
        : semanticResolved;
      let meta = this.bindObservedAssetMeta(bindTrustedCorrelationForIngest(
        serverReviewed,
        rawUniversalCorrelationClaims(input, defaults),
        sourceResolution,
        Boolean(requestToken),
        authenticatedSemanticAdapterForEvent,
        serverEnrichment.inventoryObserved,
      ), observedAt);
      // All ingress modes share the same append-only RawObservation fence. Universal/OTel events
      // used to bypass it, which made semantic API claims impossible to trace back to a source
      // fact and allowed parser failures to erase coverage context. Commit before the Judge just as
      // the Observer batch path does; the compatibility event remains fail-open on storage loss.
      meta = await this.commitCanonicalObservation(line, meta, sourceResolution, {
        sourceId: requestSourceId,
        collectorId: inputCollectorId,
        sourceType: body.sourceType
          ?? (sourceResolution.authenticated ? sourceResolution.source?.type : fallbackType),
        sourceEventId: canonicalSourceEventId,
      });
      // Source authorization is evaluated against this event's immutable scope. The batch-level
      // resolution may be intentionally false for a mixed batch, so consult the server-only
      // capability carried by `meta` before accepting provider/session anchors.
      const eventAdapterClaimAuthorized = semanticAgentEvent
        && hasAuthorizedSemanticClaim(meta, sourceResolution, 'agent_adapter');
      const rejectedScope = Boolean(serverTrustedCorrelationContext(meta)?.sourceTrust?.rejectionReason);
      meta = bindUniversalSessionIdentity(meta, input, defaults, {
        allowProviderAnchor: sourceResolution.authenticated
          && !rejectedScope
          && (meta.logicalIdentityAuthority === 'management_registration'
            || eventAdapterClaimAuthorized
            || hasAuthorizedSemanticClaim(meta, sourceResolution, 'application')),
      });
      // In the additive `off` rollout, preserve the legacy producer Run field exactly as the old
      // API did, while emitting no new trusted-correlation fields. Shadow/enabled modes require a
      // server-authorized application/Adapter claim and otherwise derive an event-local ID.
      const legacyRunId = correlationCaptureRollout().trustedCorrelation === 'off'
        ? validCorrelationClaimText(input.runId ?? defaults.runId)
        : undefined;
      const producerRunId = trustedProducerRunId(meta) ?? legacyRunId;
      const runContext = serverTrustedCorrelationContext(meta);
      meta = producerRunId
        ? { ...meta, runId: producerRunId, runIdSource: 'producer' as const }
        : { ...meta, runId: undefined, runIdSource: undefined };
      if (runContext) bindServerTrustedCorrelationContext(meta, runContext);
      let rec: T.JudgedEvent | null;
      let durableRetained = false;
      // Only the per-event server capability can authorize an Adapter idempotency reservation;
      // the batch-level policy/type hint is not sufficient when scopes are mixed or mismatched.
      const reserveProducerEvent = Boolean(producerEventKey && eventAdapterClaimAuthorized);
      if (reserveProducerEvent) reserveUniversalEvent(producerEventKey, producerEventDigest, index);
      try {
        if (judgeMode === 'sync') {
          rec = this.judge.judge(line, meta, judgedAt);
        } else {
          const outcome = await this.judge.acceptWithDisposition(
            line,
            meta,
            judgedAt,
            producerEventKey && eventAdapterClaimAuthorized
              ? `adapter-event:${producerEventKey}:${producerEventDigest}`
              : undefined,
          );
          if (outcome.disposition === 'structural_consumed' || outcome.disposition === 'discarded') {
            const structuralConsumed = outcome.disposition === 'structural_consumed';
            if (structuralConsumed) this.materializeCommittedObservedAsset(meta, observedAt);
            this.sources.recordAccepted(sourceResolution, 'event', {
              collectorId: inputCollectorId,
              workspacePath: meta.workspacePath,
            });
            acceptedEvents += 1;
            const resultItem: T.UniversalIngestResultItem = {
              index,
              accepted: true,
              disposition: 'discarded',
              ...(structuralConsumed ? { structuralConsumed: true } : {}),
              reasonCode: outcome.reasonCode,
              reason: outcome.reasonCode,
            };
            items.push(resultItem);
            if (producerEventKey) rememberUniversalEvent(producerEventKey, producerEventDigest, resultItem);
            continue;
          }
          rec = outcome.disposition === 'retained' ? outcome.event : null;
          durableRetained = outcome.disposition === 'retained' && outcome.durability === 'durable';
        }
      } catch (error) {
        if (reserveProducerEvent) forgetUniversalEventReservation(producerEventKey, producerEventDigest);
        if (!isEventRevisionConflict(error) || !producerEventKey) throw error;
        const reason = 'producer event id is already bound to a conflicting durable revision';
        this.recordRejectedIngest(sourceResolution, reason, {
          sourceId: requestSourceId,
          sourceName: body.sourceName,
          sourceType: requestSourceType,
          collectorId: inputCollectorId,
          workspacePath: inputWorkspacePath,
          endpoint,
          rejectedEvents: 1,
        });
        if (events.length === 1) throw new ConflictException(reason);
        items.push({
          index,
          accepted: false,
          disposition: 'rejected',
          reasonCode: 'producer_event_revision_conflict',
          reason,
        });
        continue;
      }
      if (!rec) {
        if (reserveProducerEvent) forgetUniversalEventReservation(producerEventKey, producerEventDigest);
        const reason = `unsupported event kind: ${kind}`;
        this.canonicalObservability.recordGap(
          'agent_adapter', 'unsupported_protocol', canonicalSourceEventId,
          { eventKind: kind },
        );
        this.recordRejectedIngest(sourceResolution, reason, {
          sourceId: requestSourceId,
          sourceName: body.sourceName,
          sourceType: requestSourceType,
          collectorId: inputCollectorId,
          workspacePath: inputWorkspacePath,
          endpoint,
          rejectedEvents: 1,
        });
        items.push({ index, accepted: false, reason });
        continue;
      }
      const resultItem = universalAcceptedResultItem(index, rec);
      if (producerEventKey) rememberUniversalEvent(producerEventKey, producerEventDigest, resultItem);
      if (kind !== 'SystemContext') {
        let semanticInteractionProjected = false;
        if (isSemanticUniversalEventKind(kind)) {
          const semanticCommit = await this.canonicalObservability.commitSemanticRecords(
            canonicalSemanticRecordForEvent(
              rec,
              canonicalSemanticAuthority(
                sourceResolution,
                inputCollectorId,
                eventAdapterClaimAuthorized,
                meta,
              ),
            ),
          );
          if (semanticCommit.rejected > 0) {
            this.canonicalObservability.recordGap(
              'projection', 'dropped', rec.eventId,
              { rejected: semanticCommit.rejected, eventKind: kind },
            );
          }
          // Application/OTLP semantic records need a compatibility Conversation projection so
          // Dify/LangGraph runs are visible through the same timeline API as passive LLM captures.
          // The projection is reference-only and therefore never copies producer prompt/body data.
          if (sourceResolution.authenticated) {
            try {
              await this.agg.storeAgentInteraction(canonicalInteractionForSemanticEvent(rec));
              semanticInteractionProjected = true;
            } catch (error) {
              this.canonicalObservability.recordGap(
                'projection',
                'storage_unavailable',
                rec.eventId,
                { projection: 'semantic_conversation', error: 'write_failed' },
              );
            }
          }
        }
        // Universal/OTLP semantic events do not pass through the legacy Interaction parser. Keep
        // their explicit Session/Run identity in the canonical membership lane as an additive
        // projection; raw facts and JudgedEvent durability remain independent of this write.
        if (!semanticInteractionProjected) {
          await this.conversationBindings?.commitEventMembership(rec);
        }
        if (durableRetained) this.materializeCommittedObservedAsset(rec, observedAt);
        await this.enqueueCanonicalShadow(rec, line);
        await this.observeSupplyChainInstall(rec, line);
        this.observeWorkspaceAssociation(rec);
        this.identityReview.considerCandidate(rec, () => this.agg.invalidateWindowCache());
        // System Context is a separate data plane. Even though the Unknown learner rejects its
        // explicit non_agent identity, observing it would still consume the learner's bounded
        // dedupe state before classification and could evict real discovery events.
        this.unknownLearning.observe(rec);
      }
      this.sources.recordAccepted(sourceResolution, 'event', { collectorId: inputCollectorId, workspacePath: rec.workspacePath });
      acceptedEvents += 1;
      items.push(resultItem);
    }
    if (acceptedEvents > 0) this.agg.invalidateWindowCache();
    return {
      accepted: acceptedEvents > 0,
      sourceId: sourceResolution.source?.sourceId,
      acceptedEvents,
      rejectedEvents: events.length - acceptedEvents,
      items,
    };
  }

  /** Bounded raw-Observer batch seam used by the node forwarder. */
  @Post('ingest/batch')
  async ingestBatch(
    @Body() body: ObserverBatchIngestBody = {},
    @Headers() headers: HeaderBag,
  ): Promise<T.ObserverBatchIngestResult> {
    const events = Array.isArray(body.events) ? body.events : [];
    if (body.durableReplay !== undefined && typeof body.durableReplay !== 'boolean') {
      throw new BadRequestException('observer durableReplay must be a boolean');
    }
    if (events.length > OBSERVER_BATCH_MAX_EVENTS) {
      // Reject before processing any prefix. The Forwarder may safely split an HTTP 413 only when
      // the controller has consumed zero items; truncating here would make its retry ambiguous.
      throw new PayloadTooLargeException(`observer batch exceeds ${OBSERVER_BATCH_MAX_EVENTS} events`);
    }
    const payload = observerBatchPayload(events);
    if (payload.bytes > OBSERVER_BATCH_MAX_BYTES) {
      // The first implementation deliberately maps one request to one ClickHouse block. Rejecting
      // before Source resolution keeps binary splitting unambiguous and avoids partial block ACKs.
      throw new PayloadTooLargeException(`observer batch exceeds ${OBSERVER_BATCH_MAX_BYTES} bytes`);
    }
    const batchId = typeof body.batchId === 'string' ? body.batchId.trim() : '';
    if (body.batchId !== undefined && (!batchId || batchId.length > OBSERVER_BATCH_ID_MAX_LENGTH)) {
      throw new BadRequestException('observer batchId is invalid');
    }
    const claimedDigest = typeof body.payloadDigest === 'string' ? body.payloadDigest.trim().toLowerCase() : '';
    if (body.payloadDigest !== undefined && !OBSERVER_BATCH_DIGEST.test(claimedDigest)) {
      throw new BadRequestException('observer payloadDigest must be a lowercase SHA-256 digest');
    }
    if (claimedDigest && claimedDigest !== payload.digest && claimedDigest !== payload.safeDigest) {
      throw new BadRequestException('observer payloadDigest does not match events');
    }
    const batchScope = headerValue(headers, 'x-anysentry-source-id')
      ?? events[0]?.sourceId
      ?? events[0]?.collectorId
      ?? 'anonymous';
    const batchCacheKey = batchId ? `${batchScope}\0${batchId}` : '';
    // Cache/idempotency state uses the secret-stripped digest; the legacy wire digest remains
    // available for protocol compatibility in the transient ACK only.
    if (batchCacheKey) rememberObserverBatchDigest(batchCacheKey, payload.safeDigest);

    // A terminal ACK is safe to return once Source authentication and the global size/digest
    // checks above have succeeded.  Resolve this before per-event enrichment/raw commits so an
    // exact Forwarder retry is genuinely side-effect free (apart from the bounded cache touch).
    if (batchCacheKey) {
      const cached = cachedObserverBatchResult(batchCacheKey, payload.safeDigest);
      if (cached) return cached;
    }

    const immediate = new Map<number, T.ObserverBatchIngestResultItem>();
    const rejectedSources = new Map<number, {
      resolution: IngestionSourceResolution;
      reason: string;
      context: RejectedIngestContext;
    }>();
    const legacyIndexes = new Set<number>();
    const preparedByIndex = new Map<number, PreparedObserverBatchEvent>();
    const retained: PreparedObserverBatchEvent[] = [];
    const structural: PreparedObserverBatchEvent[] = [];

    // Prepare is deliberately side-effect free for event persistence, hot-ring state, alerting,
    // judgment jobs, and canonical jobs. Source resolution may refresh its discovery registry, but
    // only after the global count/byte/digest checks above have completed.
    for (let index = 0; index < events.length; index += 1) {
      await yieldObserverBatchControl(index);
      const event = events[index];
      if (!event || typeof event.line !== 'string' || !event.line.trim()) {
        immediate.set(index, {
          index,
          accepted: false,
          disposition: 'rejected',
          reasonCode: 'missing_observer_line',
          reason: 'missing observer line',
        });
        continue;
      }

      if (parseCollectorHeartbeatLine(event.line)) {
        // Heartbeats use a separate control-plane persistence path. Delay the existing single-item
        // implementation until after the event block commits so it cannot create a partial prefix.
        legacyIndexes.add(index);
        continue;
      }

      const {
        line,
        collectorId: collectorIdInput,
        nodeName,
        sourceId,
        sourceName,
        sourceType,
        token,
        sourceEventId,
        ...given
      } = event;
      const collectorId = canonicalCollectorId(collectorIdInput);
      const requestSourceId = sourceId ?? headerValue(headers, 'x-anysentry-source-id');
      const requestToken = token ?? headerValue(headers, 'x-anysentry-ingest-token') ?? bearerToken(headers);
      const sourceResolution = this.sources.resolve({
        sourceId: requestSourceId,
        token: requestToken,
        collectorId,
        workspacePath: given.workspacePath,
        sourceName,
        type: sourceType,
      });
      if (!sourceResolution.accepted) {
        const reason = sourceResolution.reason ?? 'source rejected';
        immediate.set(index, {
          index,
          accepted: false,
          disposition: 'rejected',
          reason,
          reasonCode: 'source_rejected',
        });
        rejectedSources.set(index, {
          resolution: sourceResolution,
          reason,
          context: {
            sourceId: requestSourceId,
            sourceName,
            sourceType,
            collectorId,
            nodeName,
            workspacePath: given.workspacePath,
            endpoint: 'ingest/batch',
            rejectedEvents: 1,
          },
        });
        continue;
      }
      // A managed Forwarder commonly omits the per-item sourceType because the Source record is
      // already the authenticated transport authority.  Reuse that server-owned type for the
      // canonical raw lane; otherwise an Observer batch would be downgraded to an API fact and
      // lose its independent KernelFact projection.
      const effectiveSourceType = sourceType ?? sourceResolution.source?.type;
      if (
        observerLineEventKind(line) === 'CaptureAggregate' &&
        !isTrustedCollectorProducer(sourceResolution, collectorId)
      ) {
        const reason = 'capture aggregate requires an authenticated collector-bound Observer or Forwarder Source';
        immediate.set(index, {
          index,
          accepted: false,
          disposition: 'rejected',
          reason,
          reasonCode: 'source_rejected',
        });
        rejectedSources.set(index, {
          resolution: sourceResolution,
          reason,
          context: {
            sourceId: requestSourceId,
            sourceName,
            sourceType,
            collectorId,
            nodeName,
            workspacePath: given.workspacePath,
            endpoint: 'ingest/batch',
            rejectedEvents: 1,
          },
        });
        continue;
      }
      if (observerLineEventKind(line) === 'SystemContext') {
        const reason = 'SystemContext facts must use authenticated universal or OTLP ingress';
        immediate.set(index, {
          index,
          accepted: false,
          disposition: 'rejected',
          reason,
          reasonCode: 'source_rejected',
        });
        rejectedSources.set(index, {
          resolution: sourceResolution,
          reason,
          context: {
            sourceId: requestSourceId,
            sourceName,
            sourceType,
            collectorId,
            nodeName,
            workspacePath: given.workspacePath,
            endpoint: 'ingest/batch',
            rejectedEvents: 1,
          },
        });
        continue;
      }
      const metaGiven: Partial<T.EventMeta> = {
        ...given,
        sourceEventId,
        attributes: {
          ...(given.attributes ?? {}),
          ...(collectorId ? { collectorId } : {}),
          ...(nodeName ? { collectorNode: nodeName } : {}),
          ...(sourceResolution.source?.sourceId ? { sourceId: sourceResolution.source.sourceId } : {}),
          [OBSERVER_SOURCE_PAYLOAD_SHA256_ATTRIBUTE]: createHash('sha256')
            .update(JSON.stringify(digestSafeValue(event)))
            .digest('hex'),
          // A replay of a pre-privacy-migration WAL needs the old raw digest only for the
          // in-memory duplicate check.  clickhouse-store strips this marker before persistence;
          // it must never become a second durable payload fingerprint.
          ...(body.durableReplay === true ? {
            [OBSERVER_LEGACY_SOURCE_PAYLOAD_SHA256_ATTRIBUTE]: createHash('sha256')
              .update(JSON.stringify(event))
              .digest('hex'),
          } : {}),
        },
      };
      const enriched = this.kube.enrich(deriveMeta(line, metaGiven));
      const collectorEventAt = trustedCollectorEventTime(
        enriched,
        isTrustedCollectorProducer(sourceResolution, collectorId),
      );
      const timedMeta: T.EventMeta = collectorEventAt === undefined
        ? {
            ...enriched,
            eventAtUnixNs: undefined,
            receivedAtUnixNs: undefined,
            receivedAt: Date.now(),
            eventTimeQuality: 'api_received',
            captureEpoch: undefined,
            captureProfileCode: undefined,
            captureActionCode: undefined,
            captureAuthorityCode: undefined,
            captureDispositionCode: undefined,
            captureSelected: undefined,
            captureFlags: undefined,
            capturePolicyVersion: undefined,
          }
        : {
            ...enriched,
            receivedAt: unixNsMillis(enriched.receivedAtUnixNs) ?? Date.now(),
            eventTimeQuality: 'collector_calibrated',
          };
      let meta = this.bindObservedAssetMeta(bindTrustedCorrelationForIngest(
        this.agentMetadata.applyReview(timedMeta, collectorEventAt),
        rawObserverCorrelationClaims(line, given),
        sourceResolution,
        Boolean(requestToken),
      ), collectorEventAt);
      // RawObservation is the append-only provenance fence.  Commit it after source
      // authentication but before semantic/Judge preparation; a later parser or storage failure
      // must leave the raw fact and an explicit gap rather than silently deleting the observation.
      meta = await this.commitCanonicalObservation(line, meta, sourceResolution, {
        sourceId: requestSourceId,
        collectorId,
        sourceType: sourceType ?? sourceResolution.source?.type,
        sourceEventId,
      });
      meta = bindCanonicalSessionFromMeta(
        meta,
        sourceResolution.authenticated
          && (meta.logicalIdentityAuthority === 'management_registration'
            || hasAuthorizedSemanticClaim(meta, sourceResolution, 'agent_adapter')
            || hasAuthorizedSemanticClaim(meta, sourceResolution, 'application')),
      );
      const prepared = this.judge.prepareAcceptWithDisposition(line, meta, collectorEventAt ?? Date.now());
      let interaction: T.AgentInteractionRecord | undefined;
      try {
        interaction = parseObserverAgentInteraction(line, meta);
      } catch {
        // A parser/adapter exception is a semantic coverage gap, not a reason to discard the
        // already committed RawObservation/KernelFact. Keep the compatibility event on its
        // machine-side path and let a later parser revision replay it.
        interaction = undefined;
      }
      if (!interaction && observerLineEventKind(line) === 'LlmInteraction') {
        try {
          this.canonicalObservability.recordGap(
            'llm_format',
            'parser_failed',
            meta.rawObservationId ?? meta.attributes?.collectorId?.toString() ?? 'observer',
            { eventKind: 'LlmInteraction' },
          );
        } catch { /* coverage reporting must not block the durable event path */ }
      }
      const context: PreparedObserverBatchEvent = {
        index,
        body: event,
        line,
        collectorId,
        requestSourceId,
        sourceName,
        sourceType: effectiveSourceType,
        nodeName,
        sourceResolution,
        meta,
        prepared,
        ...(interaction ? { interaction } : {}),
      };
      preparedByIndex.set(index, context);
      if (prepared.disposition === 'retained') retained.push(context);
      else if (prepared.disposition === 'structural_consumed') structural.push(context);
    }

    // Exact Forwarder retries retain one batchId and payload digest. Source resolution above must
    // still run on every request, but a previously terminal ACK is the authoritative idempotency
    // result: do not re-enrich the same immutable source events into a different revision 1 after
    // a response timeout. Heartbeat/mixed legacy batches keep their existing live control path.
    let retainedForPersistence = retained;
    let durableReplayConflict = false;
    if (
      body.durableReplay === true
      && retained.length > 0
      && rejectedSources.size === 0
      && legacyIndexes.size === 0
    ) {
      let replayStatuses: Awaited<ReturnType<SentryJudgeService['classifyDurableReplayEvents']>>;
      try {
        replayStatuses = await this.judge.classifyDurableReplayEvents(
          retained.map(({ prepared }) => (prepared as PreparedRetainedJudgeAccept).event),
        );
      } catch {
        replayStatuses = null;
      }
      if (!replayStatuses) {
        return {
          accepted: false,
          ...(batchId ? { batchId } : {}),
          payloadDigest: payload.digest,
          acceptedEvents: 0,
          retainedEvents: 0,
          structuralEvents: 0,
          discardedEvents: 0,
          rejectedEvents: 0,
          retryableEvents: events.length,
          retryAfterMs: OBSERVER_BATCH_RETRY_AFTER_MS,
          items: events.map((_, index) => ({
            index,
            accepted: false,
            disposition: 'retryable',
            reasonCode: 'clickhouse_event_buffer_full',
          })),
        };
      }
      const newRetained: PreparedObserverBatchEvent[] = [];
      for (let offset = 0; offset < retained.length; offset += 1) {
        const context = retained[offset];
        const status = replayStatuses[offset];
        const prepared = context.prepared as PreparedRetainedJudgeAccept;
        if (status === 'new') {
          newRetained.push(context);
        } else if (status === 'duplicate') {
          immediate.set(context.index, {
            index: context.index,
            accepted: true,
            disposition: 'retained',
            reasonCode: 'durable_replay_duplicate',
            reason: 'durable_replay_duplicate',
            eventId: prepared.event.eventId,
          });
        } else {
          durableReplayConflict = true;
          immediate.set(context.index, {
            index: context.index,
            accepted: false,
            disposition: 'rejected',
            reasonCode: 'event_revision_conflict',
            reason: 'event_revision_conflict',
          });
        }
      }
      retainedForPersistence = newRetained;
    }

    const retainedPrepared = retainedForPersistence.map(
      ({ prepared }) => prepared as PreparedRetainedJudgeAccept,
    );
    const structuralPrepared = structural.map(({ prepared }) => prepared as PreparedStructuralJudgeAccept);
    // These markers describe accepted facts whose rebuildable projections could not be updated.
    // They are deliberately kept separate from `deliveryRetryFrom`: a projection gap must not
    // ask the Forwarder to replay an event that already crossed the immutable durability fence.
    const projectionIncompleteIndexes = new Set<number>();
    const projectionGapIdsByIndex = new Map<number, string[]>();
    const markProjectionFailure = (index: number, eventId: string, projection: string, error: unknown): void => {
      projectionIncompleteIndexes.add(index);
      const gapId = this.recordObserverProjectionFailure(eventId, projection, error);
      if (gapId) {
        const current = projectionGapIdsByIndex.get(index) ?? [];
        if (current.length < 8 && !current.includes(gapId)) current.push(gapId);
        projectionGapIdsByIndex.set(index, current);
      }
    };
    const handleProjectionFailure = (index: number, eventId: string, projection: string, error: unknown): void => {
      if (!isolatePostCommitProjection) throw error;
      markProjectionFailure(index, eventId, projection, error);
    };
    const runProjection = async <T>(
      index: number,
      eventId: string,
      projection: string,
      operation: () => Promise<T>,
      onResult: (value: T) => void = () => undefined,
    ): Promise<void> => {
      if (isolatePostCommitProjection) {
        try {
          this.scheduleObserverProjection(
            eventId,
            projection,
            operation,
            onResult,
            (error) => handleProjectionFailure(index, eventId, projection, error),
          );
        } catch (error) {
          handleProjectionFailure(index, eventId, projection, error);
        }
        return;
      }
      onResult(await operation());
    };
    let revisionConflict = false;
    let retainedDurability: 'durable' | 'memory_only' = 'memory_only';
    if (structuralPrepared.length > 0) {
      const persisted = await this.judge.persistPreparedProcessLifecycleFacts(
        structuralPrepared.map(({ fact }) => fact),
      );
      if (!persisted) {
        return {
          accepted: false,
          ...(batchId ? { batchId } : {}),
          payloadDigest: payload.digest,
          acceptedEvents: 0,
          retainedEvents: 0,
          structuralEvents: 0,
          discardedEvents: 0,
          rejectedEvents: 0,
          retryableEvents: events.length,
          retryAfterMs: OBSERVER_BATCH_RETRY_AFTER_MS,
          items: events.map((_, index) => ({
            index,
            accepted: false,
            disposition: 'retryable',
            reasonCode: 'clickhouse_event_buffer_full',
          })),
        };
      }
    }
    if (retainedPrepared.length > 0) {
      try {
        retainedDurability = await this.judge.persistPreparedBatch(
          retainedPrepared,
          `observer-batch:${batchScope}:${batchId || 'digest'}:${payload.safeDigest}`,
        );
      } catch (error) {
        if (isClickHouseEventBufferFull(error)) {
          return {
            accepted: false,
            ...(batchId ? { batchId } : {}),
            payloadDigest: payload.digest,
            acceptedEvents: 0,
            retainedEvents: 0,
            discardedEvents: 0,
            rejectedEvents: 0,
            retryableEvents: events.length,
            retryAfterMs: OBSERVER_BATCH_RETRY_AFTER_MS,
            items: events.map((_, index) => ({
              index,
              accepted: false,
              disposition: 'retryable',
              reasonCode: 'clickhouse_event_buffer_full',
            })),
          };
        }
        if (!isEventRevisionConflict(error)) throw error;
        revisionConflict = true;
      }
    }
    // Only a successful ClickHouse block gives this batch a central immutable durability fence.
    // The explicit memory-only profile remains fail-fast for downstream errors; otherwise a
    // projection failure would be misclassified as safely acknowledged without a durable fact.
    const isolatePostCommitProjection = retainedDurability === 'durable' && !revisionConflict;
    if (!revisionConflict && retainedPrepared.length > 0) {
      // The ClickHouse write above is the immutable event durability fence.  PostgreSQL-backed
      // business effects and the hot identity projection run afterwards; isolate their failures
      // so a timeout cannot make the Forwarder replay the already durable Observer batch.
      if (isolatePostCommitProjection) {
        try {
          this.judge.schedulePreparedBatchProjection(retainedPrepared, {
            onProjectionFailure: (event: T.JudgedEvent, error: unknown) => {
              const index = retainedForPersistence.find(({ prepared }) =>
                (prepared as PreparedRetainedJudgeAccept).event.eventId === event.eventId)?.index;
              if (index === undefined) return;
              markProjectionFailure(index, event.eventId, 'judgment_business_effects', error);
            },
          });
        } catch (error) {
          // A scheduler construction failure is itself post-commit projection degradation.  Keep
          // the durable event and record one bounded gap per affected item.
          for (const context of retainedForPersistence) {
            markProjectionFailure(
              context.index,
              (context.prepared as PreparedRetainedJudgeAccept).event.eventId,
              'judgment_business_effects',
              error,
            );
          }
        }
      } else {
        // A memory-only profile has no central durability fence; preserve the historical fail-fast
        // behavior so callers can retry the complete event batch safely.
        await this.judge.commitPreparedBatch(retainedPrepared);
      }
    }
    // The binding pass above is side-effect free. Publish only facts/events that crossed their
    // ClickHouse durability fence; a failed block therefore cannot create a ghost Asset/Runtime.
    for (const context of structural) {
      try {
        this.materializeCommittedObservedAsset(context.meta, trustedCollectorEventTime(
          context.meta,
          isTrustedCollectorProducer(context.sourceResolution, context.collectorId),
        ));
      } catch (error) {
        markProjectionFailure(context.index, context.meta.rawObservationId ?? `structural-${context.index}`, 'observed_asset', error);
      }
    }
    if (isolatePostCommitProjection) {
      for (const context of retainedForPersistence) {
        try {
          this.materializeCommittedObservedAsset(context.meta, trustedCollectorEventTime(
            context.meta,
            isTrustedCollectorProducer(context.sourceResolution, context.collectorId),
          ));
        } catch (error) {
          handleProjectionFailure(
            context.index,
            (context.prepared as PreparedRetainedJudgeAccept).event.eventId,
            'observed_asset',
            error,
          );
        }
      }
    }

    const items = new Array<T.ObserverBatchIngestResultItem>(events.length);
    const unknownLearningEvents: T.JudgedEvent[] = [];
    let deliveryRetryFrom = -1;
    let deliveryError = '';
    if (!revisionConflict && retainedPrepared.length > 0) {
      try {
        await this.judge.enqueuePreparedFastJobs(retainedPrepared);
      } catch (error) {
        deliveryRetryFrom = Math.min(...retainedForPersistence.map(({ index }) => index));
        // Fast-judgment enqueue is intentionally kept retryable: without a queue reservation the
        // pending decision has no worker hand-off.  This is distinct from the rebuildable
        // canonical projection below, which must never hold the Observer ACK hostage.
        deliveryError = observerProjectionFailureCode(error);
      }
      if (deliveryRetryFrom < 0) {
        if (isolatePostCommitProjection) {
          const firstContext = retainedForPersistence[0];
          if (firstContext) {
            this.scheduleObserverProjection(
              (firstContext.prepared as PreparedRetainedJudgeAccept).event.eventId,
              'canonical_stream',
              () => this.enqueueCanonicalBatchMany(retainedForPersistence),
              () => undefined,
              (error) => {
                // Kafka/Redis canonical publishing is an optional derived lane.  The immutable
                // event, KernelFact, and L1/pending judgment are already durable; retain them and
                // expose the missing projection through Coverage instead of replaying the batch.
                for (const context of retainedForPersistence) {
                  markProjectionFailure(
                    context.index,
                    (context.prepared as PreparedRetainedJudgeAccept).event.eventId,
                    'canonical_stream',
                    error,
                  );
                }
              },
            );
          }
        } else {
          try {
            await this.enqueueCanonicalBatchMany(retainedForPersistence);
          } catch (error) {
            deliveryRetryFrom = Math.min(...retainedForPersistence.map(({ index }) => index));
            deliveryError = observerProjectionFailureCode(error);
            // Keep the legacy retry path for memory-only mode, where the primary durability fence
            // has not been crossed and replay is still the safe recovery mechanism.
          }
        }
      }
    }
    let retainedCommitted = 0;
    for (let index = 0; index < events.length; index += 1) {
      await yieldObserverBatchControl(index);
      if (deliveryRetryFrom >= 0 && index >= deliveryRetryFrom) break;
      const precomputed = immediate.get(index);
      if (precomputed) {
        const rejection = rejectedSources.get(index);
        if (rejection) this.recordRejectedIngest(rejection.resolution, rejection.reason, rejection.context);
        items[index] = precomputed;
        continue;
      }
      if (legacyIndexes.has(index)) {
        try {
          const result = await this.ingest(events[index], headers);
          const declaredDisposition = 'disposition' in result ? result.disposition : undefined;
          const discarded = declaredDisposition === 'discarded';
          const accepted = result.accepted === true || discarded;
          items[index] = {
            index,
            ...result,
            accepted,
            disposition: discarded ? 'discarded' : accepted ? 'retained' : 'rejected',
          };
        } catch (error) {
          deliveryRetryFrom = index;
          deliveryError = error instanceof Error ? error.message : String(error);
        }
        continue;
      }

      const context = preparedByIndex.get(index);
      if (!context) {
        items[index] = {
          index,
          accepted: false,
          disposition: 'rejected',
          reasonCode: 'batch_prepare_missing',
          reason: 'batch preparation missing',
        };
        continue;
      }
      const prepared = context.prepared;
      if (prepared.disposition === 'discarded') {
        this.sources.recordAccepted(context.sourceResolution, 'event', {
          collectorId: context.collectorId,
          workspacePath: context.meta.workspacePath,
        });
        items[index] = {
          index,
          accepted: true,
          disposition: 'discarded',
          reasonCode: prepared.reasonCode,
          reason: prepared.reasonCode,
        };
        continue;
      }
      if (prepared.disposition === 'structural_consumed') {
        this.sources.recordAccepted(context.sourceResolution, 'event', {
          collectorId: context.collectorId,
          workspacePath: context.meta.workspacePath,
        });
        items[index] = {
          index,
          accepted: true,
          // Keep the wire disposition backward-compatible with deployed Forwarders. The additive
          // marker/reason differentiates a durable compact lifecycle fact from policy suppression.
          disposition: 'discarded',
          structuralConsumed: true,
          reasonCode: prepared.reasonCode,
          reason: prepared.reasonCode,
          ...(projectionIncompleteIndexes.has(index)
            ? {
                projectionIncomplete: true,
                ...(projectionGapIdsByIndex.get(index)?.length
                  ? { projectionGapIds: projectionGapIdsByIndex.get(index) }
                  : {}),
              }
            : {}),
        };
        continue;
      }
      if (prepared.disposition === 'rejected' || revisionConflict) {
        const reasonCode = revisionConflict
          ? 'event_revision_conflict'
          : prepared.disposition === 'rejected'
            ? prepared.reasonCode
            : 'event_revision_conflict';
        this.recordRejectedIngest(context.sourceResolution, reasonCode, {
          sourceId: context.requestSourceId,
          sourceName: context.sourceName,
          sourceType: context.sourceType,
          collectorId: context.collectorId,
          nodeName: context.nodeName,
          workspacePath: context.meta.workspacePath,
          endpoint: 'ingest/batch',
          rejectedEvents: 1,
        });
        items[index] = {
          index,
          accepted: false,
          disposition: 'rejected',
          reasonCode,
          reason: reasonCode,
        };
        continue;
      }

      if (context.interaction) {
        const interaction = {
          ...context.interaction,
          evidenceEventIds: [...new Set([
            ...(context.interaction.evidenceEventIds ?? []),
            prepared.event.eventId,
          ])],
        };
        await runProjection(
          index,
          prepared.event.eventId,
          'agent_interaction',
          () => this.agg.storeAgentInteraction(interaction),
          (stored) => {
            // `storeAgentInteraction` keeps a hot copy even when its dedicated ClickHouse
            // interaction projection is unavailable.  The event itself crossed the primary event
            // durability fence above, so expose the secondary failure without asking for replay.
            const storage = typeof this.judge.storageStatus === 'function'
              ? this.judge.storageStatus()
              : undefined;
            if (stored?.durable === false && storage?.clickhouseConfigured) {
              markProjectionFailure(
                index,
                prepared.event.eventId,
                'agent_interaction',
                { code: 'ANYSENTRY_INTERACTION_PROJECTION_UNAVAILABLE' },
              );
            }
          },
        );
        await runProjection(
          index,
          prepared.event.eventId,
          'semantic_record',
          () => this.canonicalObservability.commitSemanticRecords(
            canonicalSemanticRecordsForInteraction(
              interaction,
              canonicalSemanticAuthority(
                context.sourceResolution,
                context.collectorId,
                context.sourceResolution.claimAuthority === 'agent_adapter',
                context.meta,
              ),
            ),
          ),
          (semanticCommit) => {
            if (semanticCommit.rejected > 0) {
              this.canonicalObservability.recordGap(
                'projection', 'dropped', interaction.interactionId,
                { rejected: semanticCommit.rejected },
              );
            }
          },
        );
      } else {
        // Generic/application events have no AgentInteraction projection, but their explicit
        // Session/Run claims still belong in the canonical identity lane.  Observer
        // LlmInteraction records are materialized by AggregationService above so they do not
        // create a duplicate membership under the compatibility event id.
        await runProjection(
          index,
          prepared.event.eventId,
          'session_membership',
          async () => this.conversationBindings?.commitEventMembership(prepared.event),
        );
      }
      await this.observeSupplyChainInstall(prepared.event, context.line);
      this.observeWorkspaceAssociation(prepared.event);
      try {
        this.identityReview.considerCandidate(prepared.event, () => this.agg.invalidateWindowCache());
      } catch (error) {
        handleProjectionFailure(index, prepared.event.eventId, 'identity_review', error);
      }
      unknownLearningEvents.push(prepared.event);
      try {
        this.sources.recordAccepted(context.sourceResolution, 'event', {
          collectorId: context.collectorId,
          workspacePath: prepared.event.workspacePath,
        });
      } catch (error) {
        handleProjectionFailure(index, prepared.event.eventId, 'source_accounting', error);
      }
      retainedCommitted += 1;
      items[index] = {
        index,
        accepted: true,
        disposition: 'retained',
        eventId: prepared.event.eventId,
        traceId: prepared.event.traceId,
        invocationId: prepared.event.invocationId,
        toolCallId: prepared.event.toolCallId,
        spanId: prepared.event.spanId,
        runId: prepared.event.runId,
        verdict: prepared.event.verdict,
        tier: prepared.event.tier,
        severity: prepared.event.severity,
        riskCategory: prepared.event.riskCategory,
        decisionStatus: prepared.event.decisionStatus,
        evaluationId: prepared.event.evaluationId,
        ...(projectionIncompleteIndexes.has(index)
          ? {
              projectionIncomplete: true,
              ...(projectionGapIdsByIndex.get(index)?.length
                ? { projectionGapIds: projectionGapIdsByIndex.get(index) }
                : {}),
            }
          : {}),
      };
    }

    // Learning is a bounded recommendation plane, not part of the event durability ACK. Evaluate
    // the committed prefix once so high-rate batches do not rebuild all family state per event.
    if (unknownLearningEvents.length > 0) {
      try {
        this.unknownLearning.observeMany(unknownLearningEvents);
      } catch (error) {
        // Unknown-learning is a derived recommendation projection.  A failure here must not turn
        // a durable event prefix into a retryable suffix; retain one bounded batch-level gap.
        const firstEventId = unknownLearningEvents[0]?.eventId;
        if (firstEventId) {
          this.recordObserverProjectionFailure(firstEventId, 'unknown_learning', error);
        }
      }
    }

    if (deliveryRetryFrom >= 0) {
      for (let index = deliveryRetryFrom; index < events.length; index += 1) {
        items[index] = {
          index,
          accepted: false,
          disposition: 'retryable',
          // Keep the legacy retry code until every deployed Forwarder accepts the additive delivery
          // reason. `deliveryIncomplete` and `reason` expose the true post-commit state.
          reasonCode: 'clickhouse_event_buffer_full',
          reason: `delivery_incomplete: ${deliveryError.slice(0, 500)}`,
          deliveryIncomplete: true,
        };
      }
    }

    const acceptedEvents = items.filter((item) => item.accepted).length;
    const retainedEvents = items.filter((item) => item.disposition === 'retained').length;
    const structuralEvents = items.filter((item) => item.structuralConsumed === true).length;
    const discardedEvents = items.filter((item) => item.disposition === 'discarded').length;
    const rejectedEvents = items.filter((item) => item.disposition === 'rejected').length;
    const retryableEvents = items.filter((item) => item.disposition === 'retryable').length;
    const projectionIncompleteEvents = items.filter((item) => item.projectionIncomplete === true).length;
    if (retainedCommitted > 0) this.agg.invalidateWindowCache();
    const result: T.ObserverBatchIngestResult = {
      accepted: acceptedEvents > 0,
      ...(batchId ? { batchId } : {}),
      payloadDigest: payload.digest,
      acceptedEvents,
      retainedEvents,
      structuralEvents,
      discardedEvents,
      rejectedEvents,
      retryableEvents,
      ...(deliveryRetryFrom >= 0 ? { deliveryIncompleteEvents: events.length - deliveryRetryFrom } : {}),
      ...(projectionIncompleteEvents > 0 ? { projectionIncompleteEvents } : {}),
      ...(retryableEvents > 0 ? { retryAfterMs: OBSERVER_BATCH_RETRY_AFTER_MS } : {}),
      items,
    };
    if (
      batchCacheKey
      && !revisionConflict
      && !durableReplayConflict
      && retryableEvents === 0
      && rejectedSources.size === 0
      && legacyIndexes.size === 0
    ) {
      rememberObserverBatchResult(batchCacheKey, payload.safeDigest, result);
    }
    return result;
  }

  /** The real ingestion seam: external agents/observers POST events here to be judged + counted. */
  @Post('ingest')
  async ingest(@Body() body: IngestBody, @Headers() headers: HeaderBag) {
    const {
      line,
      collectorId: collectorIdInput,
      nodeName,
      sourceId,
      sourceName,
      sourceType,
      token,
      sourceEventId,
      ...given
    } = body;
    const collectorId = canonicalCollectorId(collectorIdInput);
    const heartbeat = parseCollectorHeartbeatLine(line);
    const requestSourceId = sourceId ?? headerValue(headers, 'x-anysentry-source-id');
    const requestToken = token ?? headerValue(headers, 'x-anysentry-ingest-token') ?? bearerToken(headers);
    if (heartbeat?.collectorId && collectorId && heartbeat.collectorId !== collectorId) {
      // Reject before Source resolution. This branch is intentionally side-effect free because the
      // optional Source identity and token have not been authenticated yet.
      const reason = 'heartbeat envelope collector does not match raw collector';
      return {
        accepted: false,
        reason,
        sourceId: requestSourceId,
      };
    }
    const requestCollectorId = collectorId ?? heartbeat?.collectorId;
    const sourceResolution = this.sources.resolve({
      sourceId: requestSourceId,
      token: requestToken,
      collectorId: requestCollectorId,
      workspacePath: given.workspacePath,
      sourceName,
      type: sourceType,
    });
    if (!sourceResolution.accepted) {
      const reason = sourceResolution.reason ?? 'source rejected';
      this.recordRejectedIngest(sourceResolution, reason, {
        sourceId: requestSourceId,
        sourceName,
        sourceType,
        collectorId: requestCollectorId,
        nodeName,
        workspacePath: given.workspacePath,
        endpoint: 'ingest',
        rejectedEvents: 1,
      });
      return { accepted: false, reason, sourceId: sourceResolution.source?.sourceId };
    }
    if (
      observerLineEventKind(line) === 'CaptureAggregate' &&
      !isTrustedCollectorProducer(sourceResolution, collectorId)
    ) {
      const reason = 'capture aggregate requires an authenticated collector-bound Observer or Forwarder Source';
      this.recordRejectedIngest(sourceResolution, reason, {
        sourceId: requestSourceId,
        sourceName,
        sourceType,
        collectorId,
        nodeName,
        workspacePath: given.workspacePath,
        endpoint: 'ingest',
        rejectedEvents: 1,
      });
      return { accepted: false, reason, sourceId: sourceResolution.source?.sourceId };
    }
    if (observerLineEventKind(line) === 'SystemContext') {
      const reason = 'SystemContext facts must use authenticated universal or OTLP ingress';
      this.recordRejectedIngest(sourceResolution, reason, {
        sourceId: requestSourceId,
        sourceName,
        sourceType,
        collectorId,
        nodeName,
        workspacePath: given.workspacePath,
        endpoint: 'ingest',
        rejectedEvents: 1,
      });
      return { accepted: false, reason, sourceId: sourceResolution.source?.sourceId };
    }
    if (
      heartbeat &&
      requestCollectorId &&
      sourceResolution.source?.collectorId &&
      canonicalCollectorId(sourceResolution.source.collectorId) !== requestCollectorId
    ) {
      const reason = 'source collector does not match heartbeat collector';
      this.recordRejectedIngest(sourceResolution, reason, {
        sourceId: requestSourceId,
        sourceName,
        sourceType,
        collectorId: requestCollectorId,
        nodeName,
        workspacePath: given.workspacePath,
        endpoint: 'ingest',
        rejectedEvents: 1,
      });
      return { accepted: false, reason, sourceId: sourceResolution.source.sourceId };
    }
    if (heartbeat) {
      const rec = this.judge.recordCollectorHeartbeat({
        ...heartbeat,
        collectorId: heartbeat.collectorId ?? requestCollectorId ?? canonicalCollectorId(sourceResolution.source?.collectorId),
        nodeName: heartbeat.nodeName ?? nodeName,
        // A raw line cannot refresh Forwarder-owned leases, receipts, or filter metrics.
        filterMetrics: undefined,
      }, Date.now(), 'raw_collector');
      this.sources.recordAccepted(sourceResolution, 'heartbeat', { collectorId: rec.collectorId, workspacePath: given.workspacePath ?? sourceResolution.source?.workspacePath });
      this.agg.invalidateWindowCache();
      if (sourceResolution.source) {
        this.alerting.observeSourceCheckIn({
          source: sourceResolution.source,
          sourceId: requestSourceId,
          sourceName,
          sourceType: sourceType ?? sourceResolution.source.type,
          collectorId: rec.collectorId,
          workspacePath: given.workspacePath,
          status: rec.status === 'error' ? 'error' : 'ok',
          message: heartbeat.message,
          at: rec.at,
        });
      }
      return { accepted: true, sourceId: sourceResolution.source?.sourceId, collectorId: rec.collectorId, receivedAt: new Date(rec.at).toISOString(), kind: 'collector-heartbeat' };
    }
      const metaGiven: Partial<T.EventMeta> = {
      ...given,
      sourceEventId,
      attributes: {
        ...(given.attributes ?? {}),
        ...(collectorId ? { collectorId } : {}),
        ...(nodeName ? { collectorNode: nodeName } : {}),
        ...(sourceResolution.source?.sourceId ? { sourceId: sourceResolution.source.sourceId } : {}),
      },
    };
    // Enrich from the same registry consumed by forwarders. Filtering is node-local; direct API
    // producers remain fail-open and are never dropped solely because metadata is incomplete.
    const enriched = this.kube.enrich(deriveMeta(line, metaGiven));
    const collectorEventAt = trustedCollectorEventTime(
      enriched,
      isTrustedCollectorProducer(sourceResolution, collectorId),
    );
    const timedMeta: T.EventMeta = collectorEventAt === undefined
      ? {
          ...enriched,
          eventAtUnixNs: undefined,
          receivedAtUnixNs: undefined,
          receivedAt: Date.now(),
          eventTimeQuality: 'api_received',
          captureEpoch: undefined,
          captureProfileCode: undefined,
          captureActionCode: undefined,
          captureAuthorityCode: undefined,
          captureDispositionCode: undefined,
          captureSelected: undefined,
          captureFlags: undefined,
          capturePolicyVersion: undefined,
        }
      : {
          ...enriched,
          receivedAt: unixNsMillis(enriched.receivedAtUnixNs) ?? Date.now(),
          eventTimeQuality: 'collector_calibrated',
        };
    let meta = this.bindObservedAssetMeta(bindTrustedCorrelationForIngest(
      this.agentMetadata.applyReview(timedMeta, collectorEventAt),
      rawObserverCorrelationClaims(line, given),
      sourceResolution,
      Boolean(requestToken),
    ), collectorEventAt);
    meta = await this.commitCanonicalObservation(line, meta, sourceResolution, {
      sourceId: requestSourceId,
      collectorId,
      sourceType: sourceType ?? sourceResolution.source?.type,
      sourceEventId,
    });
    meta = bindCanonicalSessionFromMeta(
      meta,
      sourceResolution.authenticated
        && (meta.logicalIdentityAuthority === 'management_registration'
          || hasAuthorizedSemanticClaim(meta, sourceResolution, 'agent_adapter')
          || hasAuthorizedSemanticClaim(meta, sourceResolution, 'application')),
    );
    const outcome = await this.judge.acceptWithDisposition(line, meta, collectorEventAt ?? Date.now());
    if (outcome.disposition === 'structural_consumed') {
      this.materializeCommittedObservedAsset(meta, collectorEventAt);
      this.sources.recordAccepted(sourceResolution, 'event', { collectorId, workspacePath: meta.workspacePath });
      return {
        accepted: true,
        disposition: 'discarded',
        structuralConsumed: true,
        retained: false,
        sourceId: sourceResolution.source?.sourceId,
        reasonCode: outcome.reasonCode,
        reason: outcome.reasonCode,
      };
    }
    if (outcome.disposition === 'discarded') {
      this.sources.recordAccepted(sourceResolution, 'event', { collectorId, workspacePath: meta.workspacePath });
      return {
        accepted: false,
        disposition: 'discarded',
        retained: false,
        sourceId: sourceResolution.source?.sourceId,
        reasonCode: outcome.reasonCode,
        reason: outcome.reasonCode,
      };
    }
    if (outcome.disposition === 'rejected') {
      this.recordRejectedIngest(sourceResolution, 'unparseable event', {
        sourceId: requestSourceId,
        sourceName,
        sourceType,
        collectorId,
        nodeName,
        workspacePath: meta.workspacePath,
        endpoint: 'ingest',
        rejectedEvents: 1,
      });
      return {
        accepted: false,
        disposition: 'rejected',
        retained: false,
        sourceId: sourceResolution.source?.sourceId,
        reasonCode: outcome.reasonCode,
        reason: 'unparseable event',
      };
    }
    const rec = outcome.event;
    if (outcome.durability === 'durable') {
      this.materializeCommittedObservedAsset(rec, collectorEventAt);
    }
    let interaction: T.AgentInteractionRecord | undefined;
    try {
      interaction = parseObserverAgentInteraction(line, meta);
    } catch {
      // Keep the durable compatibility event and emit a semantic coverage gap when a parser
      // revision throws on malformed/unsupported plaintext.
      interaction = undefined;
    }
    if (!interaction && observerLineEventKind(line) === 'LlmInteraction') {
      try {
        this.canonicalObservability.recordGap(
          'llm_format',
          'parser_failed',
          meta.rawObservationId ?? meta.attributes?.collectorId?.toString() ?? 'observer',
          { eventKind: 'LlmInteraction' },
        );
      } catch { /* coverage reporting must not block the durable event path */ }
    }
    if (interaction) {
      const enrichedInteraction = {
        ...interaction,
        evidenceEventIds: [...new Set([...(interaction.evidenceEventIds ?? []), rec.eventId])],
      };
      await this.agg.storeAgentInteraction(enrichedInteraction);
      const semanticCommit = await this.canonicalObservability.commitSemanticRecords(
        canonicalSemanticRecordsForInteraction(
          enrichedInteraction,
          canonicalSemanticAuthority(
            sourceResolution,
            collectorId,
            sourceResolution.claimAuthority === 'agent_adapter',
            meta,
          ),
        ),
      );
      if (semanticCommit.rejected > 0) {
        this.canonicalObservability.recordGap(
          'projection', 'dropped', enrichedInteraction.interactionId,
          { rejected: semanticCommit.rejected },
        );
      }
    } else {
      // Keep semantic/application event sessions queryable even when no legacy interaction
      // parser recognizes the line.  The canonical membership is additive and does not alter
      // the JudgedEvent or its existing compatibility projection.
      await this.conversationBindings?.commitEventMembership(rec);
    }
    await this.enqueueCanonicalShadow(rec, line);
    await this.observeSupplyChainInstall(rec, line);
    this.observeWorkspaceAssociation(rec);
    this.identityReview.considerCandidate(rec, () => this.agg.invalidateWindowCache());
    this.unknownLearning.observe(rec);
    this.sources.recordAccepted(sourceResolution, 'event', { collectorId, workspacePath: rec.workspacePath });
    this.agg.invalidateWindowCache();
    return { accepted: true, disposition: 'retained', retained: true, sourceId: sourceResolution.source?.sourceId, eventId: rec.eventId, traceId: rec.traceId, invocationId: rec.invocationId, toolCallId: rec.toolCallId, spanId: rec.spanId, runId: rec.runId, verdict: rec.verdict, tier: rec.tier, severity: rec.severity, reason: rec.reason, riskCategory: rec.riskCategory, decisionStatus: rec.decisionStatus, evaluationId: rec.evaluationId };
  }
}
