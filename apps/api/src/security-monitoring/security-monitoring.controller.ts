import { BadRequestException, Body, ConflictException, Controller, Get, Header, Headers, HttpCode, NotFoundException, Param, PayloadTooLargeException, Post, Put, Query, Sse, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Observable, exhaustMap, map, mergeMap, timer } from 'rxjs';
import { SkipWrap } from '../shared/api-response.interceptor';
import { AgentMetadataService } from './agent-metadata.service';
import { AgentRuntimeStateService } from './agent-runtime-state.service';
import { currentAgentSubjectAssetIds, mergePersistentAgentDirectory } from './agent-directory';
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
const OBSERVER_BATCH_ID_DIGEST_CACHE_SIZE = 10_000;
const observerBatchIdDigests = new Map<string, string>();
const OBSERVER_BATCH_RESULT_CACHE_SIZE = 512;
const OBSERVER_BATCH_RESULT_CACHE_BYTES = 16 * 1024 * 1024;
const observerBatchResults = new Map<string, {
  digest: string;
  result: T.ObserverBatchIngestResult;
  bytes: number;
}>();

function yieldObserverBatchControl(index: number): Promise<void> | undefined {
  if (index === 0 || index % OBSERVER_BATCH_CONTROL_YIELD_EVERY !== 0) return undefined;
  return new Promise((resolve) => setImmediate(resolve));
}
let observerBatchResultBytes = 0;
const UNIVERSAL_EVENT_IDEMPOTENCY_CACHE_SIZE = 20_000;
const universalEventIdempotency = new Map<string, {
  digest: string;
  item: T.UniversalIngestResultItem;
}>();

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

function observerBatchPayload(events: readonly IngestBody[]): { json: string; bytes: number; digest: string } {
  const json = JSON.stringify(events);
  return {
    json,
    bytes: Buffer.byteLength(json, 'utf8'),
    digest: createHash('sha256').update(json).digest('hex'),
  };
}

function rememberObserverBatchDigest(batchId: string, digest: string): void {
  const existing = observerBatchIdDigests.get(batchId);
  if (existing && existing !== digest) {
    throw new BadRequestException('observer batchId conflicts with a different payloadDigest');
  }
  if (existing) observerBatchIdDigests.delete(batchId);
  observerBatchIdDigests.set(batchId, digest);
  while (observerBatchIdDigests.size > OBSERVER_BATCH_ID_DIGEST_CACHE_SIZE) {
    const oldest = observerBatchIdDigests.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    observerBatchIdDigests.delete(oldest);
  }
}

function cachedObserverBatchResult(batchKey: string, digest: string): T.ObserverBatchIngestResult | undefined {
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
  const copy = structuredClone(result);
  const bytes = Buffer.byteLength(JSON.stringify(copy), 'utf8');
  if (bytes > OBSERVER_BATCH_RESULT_CACHE_BYTES) return;
  const previous = observerBatchResults.get(batchKey);
  if (previous) {
    observerBatchResultBytes = Math.max(0, observerBatchResultBytes - previous.bytes);
    observerBatchResults.delete(batchKey);
  }
  observerBatchResults.set(batchKey, { digest, result: copy, bytes });
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
  }
}

function universalEventReplay(
  key: string,
  digest: string,
): { item?: T.UniversalIngestResultItem; conflict: boolean } | undefined {
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
  if (universalEventIdempotency.has(key)) universalEventIdempotency.delete(key);
  universalEventIdempotency.set(key, { digest, item: structuredClone(item) });
  while (universalEventIdempotency.size > UNIVERSAL_EVENT_IDEMPOTENCY_CACHE_SIZE) {
    const oldest = universalEventIdempotency.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    universalEventIdempotency.delete(oldest);
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
  ) universalEventIdempotency.delete(key);
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

function isLlmEndpoint(inner: Record<string, unknown>): boolean {
  const a = inner as { peer?: string; sni?: string; query?: string };
  const peer = a.peer ?? '';
  const sni = a.sni ?? '';
  const query = a.query ?? '';
  return LLM_ENDPOINTS.some((e) => peer === e || (sni !== '' && sni.includes(e)) || (query !== '' && query.includes(e)));
}

function eventCategory(kind: string): T.EventCategory {
  if (kind === 'ToolExec' || kind === 'AgentTool') return 'tool';
  if (kind === 'Egress' || kind === 'Dns' || kind === 'SslContent') return 'network';
  if (kind === 'FileAccess' || kind === 'FileDelete') return 'file';
  if (kind === 'LlmCall' || kind === 'LlmApi' || kind === 'LlmInteraction') return 'llm';
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

function attrValue(v: unknown, key?: string): T.EventAttributeValue | undefined {
  if (key && sensitiveAttributeKey(key)) return '[redacted]';
  if (typeof v === 'string') return redact(v).slice(0, 240);
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
    mountNamespace: numberField('mountNamespace') ?? numberField('mount_namespace'),
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
  try {
    const o = JSON.parse(line) as {
      identity?: typeof id;
      process?: unknown;
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
  // Surface an agent→LLM-endpoint connection as an LlmCall even when it isn't an SNI-classified
  // public provider (internal/self-hosted endpoints, plain HTTP).
  const isLlm = (eventKey === 'Egress' || eventKey === 'Dns') && isLlmEndpoint(inner);
  const peer = (inner as { peer?: string; query?: string }).peer ?? (inner as { query?: string }).query ?? '';
  return {
    agentId,
    workspacePath: given.workspacePath ?? cwd ?? `agent://${agentId}`,
    // A session is a logical work unit. The kernel rarely knows an app-level session id, so fall
    // back to the AGENT (workload), NOT the pid — else every short-lived process counts as a session.
    sessionId: given.sessionId ?? id.session ?? id.agent ?? (id.task != null ? `task-${id.task}` : 'session'),
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
    runId: given.runId ?? id.session ?? id.agent ?? (id.task != null ? `task-${id.task}` : undefined),
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
    attributes: { ...sanitizeEventAttributes(given.attributes), ...compactAttributes(eventKey, inner, id) },
    classificationSemantics: given.classificationSemantics,
    // Process generation is structural evidence and therefore shares the raw-record trust boundary
    // with event time and capture decisions.
    process,
    attribution: given.attribution,
    rawPreview: given.rawPreview ?? redact(line).slice(0, 1800),
    subject: given.subject ?? (isLlm ? `LLM 调用 → ${peer}` : summarize(eventKey, inner)),
    tokenCount: given.tokenCount,
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
    execute_tool: 'AgentTool',
    agent_invocation: 'AgentInvocation',
    agentinvocation: 'AgentInvocation',
    invoke_agent: 'AgentInvocation',
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
    const peer = cleanString(input.peer ?? input.endpoint ?? eventAttr(input, 'peer') ?? eventAttr(input, 'endpoint'), 500) ?? 'unknown';
    const port = finiteNumber(input.port ?? eventAttr(input, 'port'));
    return { ...base, peer, ...(port !== undefined ? { port } : {}) };
  }
  if (kind === 'Dns') return { ...base, query: cleanString(input.query ?? input.peer ?? input.endpoint ?? eventAttr(input, 'query'), 500) ?? 'unknown' };
  if (kind === 'FileAccess' || kind === 'FileDelete') return { ...base, path: cleanString(input.path ?? eventAttr(input, 'path'), 800) ?? 'unknown' };
  if (kind === 'LlmCall') {
    const endpoint = cleanString(input.sni ?? input.endpoint ?? input.peer ?? eventAttr(input, 'sni') ?? eventAttr(input, 'endpoint'), 500) ?? 'llm';
    return { ...base, sni: endpoint, peer: endpoint };
  }
  if (kind === 'LlmApi') {
    const endpoint = cleanString(input.sni ?? input.endpoint ?? input.peer ?? eventAttr(input, 'sni') ?? eventAttr(input, 'endpoint'), 500) ?? 'llm';
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
  return { ...base, ...sanitizeEventAttributes(input.attributes) };
}

function universalEventLine(kind: string, input: T.UniversalIngestEvent, defaults: T.UniversalIngestRequest): string {
  const agent = cleanString(input.agentId ?? defaults.agentId, 240) ?? 'api-agent';
  const session = cleanString(input.sessionId ?? defaults.sessionId, 240);
  const task = cleanString(input.taskId ?? defaults.taskId, 240);
  const identity = { agent, ...(session ? { session } : {}), ...(task ? { task } : {}) };
  return JSON.stringify({ identity, event: { [kind]: eventInner(kind, input) } });
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
    rawPreview: cleanString(redact(JSON.stringify({ ...envelope, token: undefined })), 1800),
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
    taskId: cleanString(input.taskId ?? defaults.taskId, 240),
    subject: cleanString(input.subject ?? defaults.subject, 500),
    tokenCount: finiteNumber(input.tokenCount ?? defaults.tokenCount),
    latencyMs: finiteNumber(input.latencyMs ?? defaults.latencyMs),
    rawPreview: cleanString(input.rawPreview ?? defaults.rawPreview, 1800),
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

type RawProducerCorrelationClaims = {
  invocationId?: unknown;
  toolCallId?: unknown;
  traceId?: unknown;
  sessionId?: unknown;
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
    tenantId: metaAttributeText(meta, 'tenantId', 'tenant.id', 'anysentry.tenant.id')
      ?? process.env.ANYSENTRY_TENANT_ID?.trim()
      ?? 'default',
    environmentId: metaAttributeText(
      meta,
      'environmentId',
      'environment.id',
      'anysentry.environment.id',
      'deployment.environment.name',
    ) ?? process.env.ANYSENTRY_ENVIRONMENT_ID?.trim() ?? 'local',
    workspaceId: metaAttributeText(meta, 'workspaceId', 'workspace.id', 'anysentry.workspace.id'),
    workspacePath: cleanString(meta.workspacePath, 500),
    physicalWorkloadId: cleanString(meta.attribution?.physicalWorkloadId, 240),
    agentScopeId: cleanString(meta.attribution?.agentScopeId, 160),
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
      'gen_ai.tool.call.id',
      'tool_call.id',
    );
  const traceId = producerClaims.traceId;
  const sessionId = producerClaims.sessionId;
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
    ? [invocationId, toolCallId, sessionId, traceId].some(claimSupplied)
    : [invocationId, traceId].some(claimSupplied);
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
            sessionConsistent,
            traceConsistent,
            scope,
          },
        }
      : {
          application: {
            invocationId,
            traceId,
            traceConsistent,
            scope,
          },
        };
  }

  return bindServerTrustedCorrelationContext(boundMeta, {
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
    rawPreview: cleanString(JSON.stringify({ ...body, token: undefined }), 1800),
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
    rawPreview: cleanString(JSON.stringify({ ...body, token: undefined, event }), 1800),
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
  const resourceSession = body.sessionId ?? selectedRawAttribute(
    resourceAttrs,
    normalizedResourceAttrs,
    'anysentry.session.id',
    'gen_ai.conversation.id',
    'session.id',
    'service.instance.id',
    'k8s.pod.uid',
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
      'gen_ai.tool.call.id',
      'tool_call.id',
    ) ?? body.toolCallId,
    traceId: record.traceId ?? body.traceId ?? body.traceparent,
    sessionId: resourceSession ?? firstRawAttribute(
      combined,
      'anysentry.session.id',
      'gen_ai.conversation.id',
      'session.id',
      'service.instance.id',
    ) ?? resourceService,
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
  if (typeof value === 'string') return cleanString(value, 500);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const wrapped = obj(value);
  if (!wrapped) return undefined;
  for (const key of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) {
    if (!(key in wrapped)) continue;
    const raw = wrapped[key];
    if (key === 'boolValue') return Boolean(raw);
    if (key === 'stringValue') return cleanString(raw, 500);
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

function otlpDefaults(resourceAttrs: Record<string, T.EventAttributeValue>, body: T.UniversalIngestRequest): Partial<T.UniversalIngestRequest> {
  const service = attrText(resourceAttrs, 'anysentry.agent.id', 'agent.id', 'service.name', 'k8s.pod.name', 'process.executable.name');
  const namespace = attrText(resourceAttrs, 'anysentry.workspace', 'service.namespace', 'k8s.namespace.name', 'deployment.environment.name');
  const workspacePath = attrText(resourceAttrs, 'anysentry.workspace') ?? (namespace && service ? `${namespace}/${service}` : namespace ? `workspace://${namespace}` : service ? `service://${service}` : undefined);
  return {
    workspacePath: body.workspacePath ?? workspacePath,
    agentId: body.agentId ?? service,
    sessionId: body.sessionId ?? attrText(resourceAttrs, 'anysentry.session.id', 'gen_ai.conversation.id', 'session.id', 'service.instance.id', 'k8s.pod.uid') ?? service,
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
  return {
    ...item,
    kind: inferredKind,
    eventKind: item.eventKind ?? inferredKind,
    agentId: item.agentId ?? attrText(combined, 'anysentry.agent.id', 'agent.id', 'service.name', 'k8s.pod.name'),
    workspacePath: item.workspacePath ?? attrText(combined, 'anysentry.workspace'),
    sessionId: item.sessionId ?? attrText(combined, 'anysentry.session.id', 'gen_ai.conversation.id', 'session.id', 'service.instance.id'),
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
export class SecurityMonitoringController {
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
  ) {}

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
  @RequireManagementAuth()
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
    return this.agentRuntimeState.recordSnapshot(body);
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
        ? createHash('sha256').update(JSON.stringify({ defaults: idempotencyDefaults, input })).digest('hex')
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
      const authenticatedSemanticAdapter = (
        kind === 'AgentTool' || kind === 'AgentInvocation'
      ) && sourceResolution.authenticated
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
      const derived = deriveMeta(line, {
        ...partial,
        eventKind: kind,
        eventCategory: partial.eventCategory ?? eventCategory(kind),
      });
      const hasProducerTime = input.at !== undefined || input.timestamp !== undefined || eventAttr(input, 'timestamp') !== undefined;
      const observedAt = sourceResolution.authenticated ? eventTime(input) : undefined;
      const judgedAt = observedAt ?? Date.now();
      const timedDerived: T.EventMeta = {
        ...derived,
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
      const semanticAgentEvent = kind === 'AgentTool' || kind === 'AgentInvocation';
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
      const meta = this.bindObservedAssetMeta(bindTrustedCorrelationForIngest(
        serverReviewed,
        rawUniversalCorrelationClaims(input, defaults),
        sourceResolution,
        Boolean(requestToken),
        authenticatedSemanticAdapterForEvent,
        serverEnrichment.inventoryObserved,
      ), observedAt);
      let rec: T.JudgedEvent | null;
      let durableRetained = false;
      const reserveProducerEvent = Boolean(producerEventKey && authenticatedSemanticAdapterForEvent);
      if (reserveProducerEvent) reserveUniversalEvent(producerEventKey, producerEventDigest, index);
      try {
        if (judgeMode === 'sync') {
          rec = this.judge.judge(line, meta, judgedAt);
        } else {
          const outcome = await this.judge.acceptWithDisposition(
            line,
            meta,
            judgedAt,
            producerEventKey && authenticatedSemanticAdapterForEvent
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
    if (claimedDigest && claimedDigest !== payload.digest) {
      throw new BadRequestException('observer payloadDigest does not match events');
    }
    const batchScope = headerValue(headers, 'x-anysentry-source-id')
      ?? events[0]?.sourceId
      ?? events[0]?.collectorId
      ?? 'anonymous';
    const batchCacheKey = batchId ? `${batchScope}\0${batchId}` : '';
    if (batchCacheKey) rememberObserverBatchDigest(batchCacheKey, payload.digest);

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
            .update(JSON.stringify(event))
            .digest('hex'),
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
      const meta = this.bindObservedAssetMeta(bindTrustedCorrelationForIngest(
        this.agentMetadata.applyReview(timedMeta, collectorEventAt),
        rawObserverCorrelationClaims(line, given),
        sourceResolution,
        Boolean(requestToken),
      ), collectorEventAt);
      const prepared = this.judge.prepareAcceptWithDisposition(line, meta, collectorEventAt ?? Date.now());
      const interaction = parseObserverAgentInteraction(line, meta);
      const context: PreparedObserverBatchEvent = {
        index,
        body: event,
        line,
        collectorId,
        requestSourceId,
        sourceName,
        sourceType,
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
    if (batchCacheKey && rejectedSources.size === 0 && legacyIndexes.size === 0) {
      const cached = cachedObserverBatchResult(batchCacheKey, payload.digest);
      if (cached) return cached;
    }

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
          `observer-batch:${batchScope}:${batchId || 'digest'}:${payload.digest}`,
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
    if (!revisionConflict && retainedPrepared.length > 0) {
      await this.judge.commitPreparedBatch(retainedPrepared);
    }
    // The binding pass above is side-effect free. Publish only facts/events that crossed their
    // ClickHouse durability fence; a failed block therefore cannot create a ghost Asset/Runtime.
    for (const context of structural) {
      this.materializeCommittedObservedAsset(context.meta, trustedCollectorEventTime(
        context.meta,
        isTrustedCollectorProducer(context.sourceResolution, context.collectorId),
      ));
    }
    if (!revisionConflict && retainedDurability === 'durable') {
      for (const context of retainedForPersistence) {
        this.materializeCommittedObservedAsset(context.meta, trustedCollectorEventTime(
          context.meta,
          isTrustedCollectorProducer(context.sourceResolution, context.collectorId),
        ));
      }
    }

    const items = new Array<T.ObserverBatchIngestResultItem>(events.length);
    const unknownLearningEvents: T.JudgedEvent[] = [];
    let deliveryRetryFrom = -1;
    let deliveryError = '';
    if (!revisionConflict && retainedPrepared.length > 0) {
      try {
        await this.judge.enqueuePreparedFastJobs(retainedPrepared);
        await this.enqueueCanonicalBatchMany(retainedForPersistence);
      } catch (error) {
        deliveryRetryFrom = Math.min(...retainedForPersistence.map(({ index }) => index));
        deliveryError = error instanceof Error ? error.message : String(error);
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

      try {
        if (context.interaction) await this.agg.storeAgentInteraction(context.interaction);
        await this.observeSupplyChainInstall(prepared.event, context.line);
        this.observeWorkspaceAssociation(prepared.event);
        this.identityReview.considerCandidate(prepared.event, () => this.agg.invalidateWindowCache());
        unknownLearningEvents.push(prepared.event);
        this.sources.recordAccepted(context.sourceResolution, 'event', {
          collectorId: context.collectorId,
          workspacePath: prepared.event.workspacePath,
        });
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
        };
      } catch (error) {
        deliveryRetryFrom = index;
        deliveryError = error instanceof Error ? error.message : String(error);
      }
    }

    // Learning is a bounded recommendation plane, not part of the event durability ACK. Evaluate
    // the committed prefix once so high-rate batches do not rebuild all family state per event.
    if (unknownLearningEvents.length > 0) this.unknownLearning.observeMany(unknownLearningEvents);

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
      rememberObserverBatchResult(batchCacheKey, payload.digest, result);
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
    const meta = this.bindObservedAssetMeta(bindTrustedCorrelationForIngest(
      this.agentMetadata.applyReview(timedMeta, collectorEventAt),
      rawObserverCorrelationClaims(line, given),
      sourceResolution,
      Boolean(requestToken),
    ), collectorEventAt);
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
    const interaction = parseObserverAgentInteraction(line, meta);
    if (interaction) await this.agg.storeAgentInteraction(interaction);
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
