import { BadRequestException, Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, Post, Put, Query, Sse, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Observable, map, timer } from 'rxjs';
import { SkipWrap } from '../shared/api-response.interceptor';
import { AgentMetadataService } from './agent-metadata.service';
import { AggregationService } from './aggregation.service';
import { AlertingService } from './alerting.service';
import { AuditService } from './audit.service';
import { IngestionSourceResolution, IngestionSourceService } from './ingestion-source.service';
import { KubeIdentityService } from './kube-identity.service';
import { managementAuthConfigured, ManagementAuthGuard, RequireManagementAuth } from './management-auth.guard';
import { MaintenanceWindowService } from './maintenance-window.service';
import { NotificationService } from './notification.service';
import { ObjectiveService } from './objective.service';
import { PolicyConfigError } from './policy-config';
import { RemediationService } from './remediation.service';
import { SentryJudgeService } from './sentry-judge.service';
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

function isLlmEndpoint(inner: Record<string, unknown>): boolean {
  const a = inner as { peer?: string; sni?: string; query?: string };
  const peer = a.peer ?? '';
  const sni = a.sni ?? '';
  const query = a.query ?? '';
  return LLM_ENDPOINTS.some((e) => peer === e || (sni !== '' && sni.includes(e)) || (query !== '' && query.includes(e)));
}

function eventCategory(kind: string): T.EventCategory {
  if (kind === 'ToolExec') return 'tool';
  if (kind === 'Egress' || kind === 'Dns' || kind === 'SslContent') return 'network';
  if (kind === 'FileAccess' || kind === 'FileDelete') return 'file';
  if (kind === 'LlmCall' || kind === 'LlmApi') return 'llm';
  if (kind === 'SecurityAction') return 'security';
  if (kind === 'ProcessExit') return 'process';
  if (kind === 'RuntimeEvent') return 'runtime';
  return 'unknown';
}

const TOKEN_COUNTER_KEY = /(^|_)(token_count|prompt_tokens|completion_tokens|total_tokens|input_tokens|output_tokens)($|_)/;
const SENSITIVE_KEY = /(^|_)(authorization|api_key|apikey|access_token|accesstoken|refresh_token|refreshtoken|id_token|idtoken|token|secret|password|passwd|credential|credentials)($|_)/;

function sensitiveAttributeKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return !TOKEN_COUNTER_KEY.test(normalized) && SENSITIVE_KEY.test(normalized);
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
  for (const key of ['pid', 'uid', 'cwd', 'peer', 'port', 'query', 'path', 'sni', 'kind', 'prompt_tokens', 'completion_tokens']) {
    const v = attrValue(a[key], key);
    if (v !== undefined) attrs[key] = v;
  }
  if (Array.isArray(a.argv)) attrs.argv = redact(a.argv.join(' ')).slice(0, 300);
  if (id.task != null) attrs.observerTask = String(id.task).slice(0, 120);
  attrs.observerKind = kind;
  return attrs;
}

function summarize(kind: string, inner: Record<string, unknown>): string {
  const a = inner as { argv?: string[]; peer?: string; port?: number; query?: string; path?: string; sni?: string; kind?: string };
  if (kind === 'ToolExec') return redact((a.argv ?? []).join(' ')).slice(0, 80) || 'exec';
  if (kind === 'Egress') return `egress → ${a.peer ?? '?'}${a.port ? `:${a.port}` : ''}`;
  if (kind === 'Dns') return `dns ${a.query ?? ''}`;
  if (kind === 'FileAccess') return `file ${a.path ?? ''}`;
  if (kind === 'SslContent') return 'ssl content';
  if (kind === 'SecurityAction') return `security ${a.kind ?? ''}`;
  if (kind === 'LlmCall') return `llm ${a.sni ?? ''}`;
  return kind;
}

/** Fill EventMeta from an a3s-observer line's identity + event, honoring any explicitly-given fields. */
function deriveMeta(line: string, given: Partial<T.EventMeta>): T.EventMeta {
  let id: { agent?: string; task?: string | number; session?: string } = {};
  let eventKey = 'Event';
  let inner: Record<string, unknown> = {};
  try {
    const o = JSON.parse(line) as { identity?: typeof id; event?: Record<string, Record<string, unknown>> };
    id = o.identity ?? {};
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
    source: given.source ?? 'observer',
    traceId: given.traceId,
    spanId: given.spanId,
    parentSpanId: given.parentSpanId,
    runId: given.runId ?? id.session ?? id.agent ?? (id.task != null ? `task-${id.task}` : undefined),
    taskId: given.taskId ?? (id.task != null ? String(id.task) : undefined),
    attributes: { ...compactAttributes(eventKey, inner, id), ...sanitizeEventAttributes(given.attributes) },
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

function strArrayField(o: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const v = o[key];
    if (Array.isArray(v)) return v.map((item) => String(item)).filter(Boolean);
  }
  return undefined;
}

function parseCollectorHeartbeatLine(line: string): T.CollectorHeartbeatRequest | null {
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
      ['file', 'FileAccess'],
      ['llm', 'LlmCall'],
      ['ssl', 'SslContent'],
      ['sec', 'SecurityAction'],
    ];
    for (const [sourceKey, kind] of countMap) {
      const count = numField(hb, sourceKey);
      if (count !== undefined) eventKindCounts[kind] = count;
    }
    const explicitCounts = obj(hb.eventKindCounts) ?? obj(hb.event_kind_counts);
    if (explicitCounts) {
      for (const [key, value] of Object.entries(explicitCounts)) {
        const count = Number(value);
        if (Number.isFinite(count)) eventKindCounts[key] = count;
      }
    }
    return {
      collectorId: strField(hb, 'collectorId', 'collector_id'),
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
  for (const key of ['primaryType', 'primaryId', 'auditId', 'edgeId', 'eventId', 'incidentId', 'alertId', 'taskId', 'objectiveId', 'issueId', 'deliveryId', 'windowId', 'workspacePath', 'agentId', 'collectorId', 'sourceId', 'traceId', 'runId', 'sessionId'] as const) {
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
  if (Array.isArray(direct)) return direct.map((item) => cleanString(item, 200)).filter((item): item is string => Boolean(item)).slice(0, 80);
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
  if (kind === 'ToolExec') return { ...base, argv: argvField(input) ?? ['unknown'] };
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
  if (kind === 'ProcessExit') return { ...base, status: finiteNumber(input.status ?? eventAttr(input, 'status')) ?? 0 };
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
    const events = records.flatMap((record) => {
      if (!record) return [{ kind: 'invalid', subject: 'invalid batch item', attributes: { invalidBatchItem: true } }];
      const item = normalizeCloudEvent(record as T.UniversalIngestRequest & Record<string, unknown>);
      return item.event ? [item.event] : universalEvents(item);
    });
    const first = records.find((item): item is T.UniversalIngestRequest & Record<string, unknown> => Boolean(item));
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
    spanId: cleanString(input.spanId ?? defaults.spanId, 240),
    parentSpanId: cleanString(input.parentSpanId ?? defaults.parentSpanId, 240),
    runId: cleanString(input.runId ?? defaults.runId, 240),
    taskId: cleanString(input.taskId ?? defaults.taskId, 240),
    subject: cleanString(input.subject ?? defaults.subject, 500),
    tokenCount: finiteNumber(input.tokenCount ?? defaults.tokenCount),
    latencyMs: finiteNumber(input.latencyMs ?? defaults.latencyMs),
    rawPreview: cleanString(input.rawPreview ?? defaults.rawPreview, 1800),
    attributes: attrs,
  };
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
    sessionId: body.sessionId ?? attrText(resourceAttrs, 'anysentry.session.id', 'session.id', 'service.instance.id', 'k8s.pod.uid') ?? service,
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
  const inferredKind =
    explicitKind ??
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
    sessionId: item.sessionId ?? attrText(combined, 'anysentry.session.id', 'session.id', 'service.instance.id'),
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
    const defaults = otlpDefaults(resourceAttrs, body);
    const scopes = (obj(resourceLog)?.scopeLogs ?? obj(resourceLog)?.instrumentationLibraryLogs) as unknown;
    for (const scopeLog of Array.isArray(scopes) ? scopes : []) {
      const records = obj(scopeLog)?.logRecords ?? obj(scopeLog)?.logs;
      for (const record of Array.isArray(records) ? records : []) {
        const rec = obj(record) ?? {};
        const attrs = otlpAttributes(rec.attributes);
        const bodyText = otlpBodyText(rec.body);
        if (bodyText) attrs['log.record.body'] = bodyText;
        events.push(universalFromOtelAttrs(attrs, resourceAttrs, {
          ...defaults,
          at: otlpTimeMs(rec.timeUnixNano, rec.observedTimeUnixNano),
          traceId: cleanString(rec.traceId, 240),
          spanId: cleanString(rec.spanId, 240),
          subject: bodyText ?? cleanString(rec.severityText, 240) ?? 'otel log',
          source: 'api',
        }));
      }
    }
  }

  const resourceSpans = Array.isArray(body.resourceSpans) ? body.resourceSpans : [];
  for (const resourceSpan of resourceSpans) {
    const resource = obj(resourceSpan)?.resource;
    const resourceAttrs = otlpAttributes(obj(resource)?.attributes);
    const defaults = otlpDefaults(resourceAttrs, body);
    const scopes = (obj(resourceSpan)?.scopeSpans ?? obj(resourceSpan)?.instrumentationLibrarySpans) as unknown;
    for (const scopeSpan of Array.isArray(scopes) ? scopes : []) {
      const spans = obj(scopeSpan)?.spans;
      for (const span of Array.isArray(spans) ? spans : []) {
        const rec = obj(span) ?? {};
        const attrs = otlpAttributes(rec.attributes);
        events.push(universalFromOtelAttrs(attrs, resourceAttrs, {
          ...defaults,
          at: otlpTimeMs(rec.startTimeUnixNano, rec.endTimeUnixNano),
          traceId: cleanString(rec.traceId, 240),
          spanId: cleanString(rec.spanId, 240),
          parentSpanId: cleanString(rec.parentSpanId, 240),
          subject: cleanString(rec.name, 500) ?? 'otel span',
          source: 'api',
        }));
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
    private readonly kube: KubeIdentityService,
  ) {}

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

  @Post('top/healthCard')
  @HttpCode(200)
  healthCard(@Body() f: T.SecurityTimeFilter) {
    return this.agg.healthCard(f);
  }

  @Post('top/explainabilityScan')
  @HttpCode(200)
  explainabilityScan(@Body() f: T.ExplainabilityScanRequest) {
    return this.agg.explainabilityScan(f);
  }

  @Post('top/performanceCard')
  @HttpCode(200)
  performanceCard(@Body() f: T.SecurityTimeFilter) {
    return this.agg.performanceCard(f);
  }

  @Post('risks/summary')
  @HttpCode(200)
  riskSummary(@Body() f: T.SecurityTimeFilter) {
    return this.agg.riskSummary(f);
  }

  @Post('risks/breakdown')
  @HttpCode(200)
  riskBreakdown(@Body() f: T.SecurityTimeFilter) {
    return this.agg.riskBreakdown(f);
  }

  @Post('sessions/highestRisk')
  @HttpCode(200)
  highestRisk(@Body() f: T.SecurityTimeFilter) {
    return this.agg.highestRiskSession(f);
  }

  @Post('sessions/decisionFunnel')
  @HttpCode(200)
  decisionFunnel(@Body() f: T.SecurityTimeFilter) {
    return this.agg.decisionFunnel(f);
  }

  @Post('sessions/agentObservability')
  @HttpCode(200)
  agentObservability(@Body() f: T.SecurityTimeFilter) {
    return this.agg.agentObservability(f);
  }

  @Post('sessions/workspaceRiskDistribution')
  @HttpCode(200)
  workspaceRiskDistribution(@Body() f: T.SecurityTimeFilter) {
    return this.agg.workspaceRiskDistribution(f);
  }

  @Post('events/list')
  @HttpCode(200)
  agentEvents(@Body() f: T.AgentEventQuery) {
    return this.agg.agentEvents(f);
  }

  @Post('events/timeline')
  @HttpCode(200)
  agentTimeline(@Body() f: T.AgentEventQuery) {
    return this.agg.agentTimeline(f);
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
    return this.agg.agentInventory(f);
  }

  @Post('workspaces/inventory')
  @HttpCode(200)
  workspaceInventory(@Body() f: T.WorkspaceInventoryQuery) {
    return this.agg.workspaceInventory(f);
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
      resourceId: `${updated.workspacePath}:${updated.agentId}`,
      summary: `Agent metadata updated: ${updated.displayName || updated.agentId}`,
      details: {
        agentId: updated.agentId,
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

  @Post('agents/topology')
  @HttpCode(200)
  agentTopology(@Body() f: T.AgentTopologyQuery) {
    return this.agg.agentTopology(f);
  }

  @Post('collectors/heartbeat')
  collectorHeartbeat(@Body() body: T.CollectorHeartbeatRequest, @Headers() headers: HeaderBag) {
    const requestSourceId = body.sourceId ?? headerValue(headers, 'x-anysentry-source-id');
    const requestToken = body.token ?? headerValue(headers, 'x-anysentry-ingest-token') ?? bearerToken(headers);
    const requestSourceType = body.sourceType ?? 'forwarder';
    const requestCollectorId = body.collectorId;
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

    const rec = this.judge.recordCollectorHeartbeat({
      ...body,
      collectorId: body.collectorId ?? sourceResolution.source?.collectorId,
    });
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
  collectorHealth(@Body() f: T.CollectorHealthQuery) {
    return this.agg.collectorHealth(f);
  }

  @Post('sources/list')
  @HttpCode(200)
  ingestionSources(@Body() f: T.IngestionSourceQuery) {
    return this.sources.list(f);
  }

  @Post('sources')
  @RequireManagementAuth()
  createIngestionSource(@Body() body: T.IngestionSourceUpdateRequest, @Headers() headers: HeaderBag) {
    const result = this.sources.create(body);
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
      },
    });
    return result;
  }

  @Put('sources/:sourceId')
  @RequireManagementAuth()
  updateIngestionSource(@Param('sourceId') sourceId: string, @Body() body: T.IngestionSourceUpdateRequest, @Headers() headers: HeaderBag) {
    const result = this.sources.update(sourceId, body);
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
  coverageOverview(@Body() f: T.CoverageQuery) {
    const coverage = this.agg.coverageOverview(f);
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

  @Post('evidence/bundle')
  @HttpCode(200)
  evidenceBundle(@Body() query: T.EvidenceBundleQuery = {}): T.EvidenceBundle {
    const timeFilter: T.SecurityTimeFilter = {
      timeType: query.timeType ?? 'last_30d',
      startTime: query.startTime,
      endTime: query.endTime,
    };
    const limit = Math.max(10, Math.min(100, query.limit ?? 60));
    const explicitAuditId = selector(query.auditId, 180);
    const explicitEdgeId = selector(query.edgeId, 180);
    const explicitEventId = selector(query.eventId, 180);
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

    let remediation = explicitTaskId ? this.remediation.list({ ...timeFilter, taskId: explicitTaskId, status: 'all', limit: 1 }).items[0] : undefined;
    if (!remediation && auditTaskId) {
      remediation = this.remediation.list({ ...timeFilter, taskId: auditTaskId, status: 'all', limit: 1 }).items[0];
    }
    if (!remediation && notificationDelivery?.taskId) {
      remediation = this.remediation.list({ ...timeFilter, taskId: notificationDelivery.taskId, status: 'all', limit: 1 }).items[0];
    }
    if (!remediation && explicitIssueId) {
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
    let event = relatedEventId ? this.agg.agentEvents({ ...timeFilter, eventId: relatedEventId, limit: 1 }).items[0] : undefined;
    if (!event && query.traceId) event = this.agg.agentEvents({ ...timeFilter, traceId: selector(query.traceId, 240), limit: 1 }).items[0];

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
      sessionId: scope.sessionId,
      workspacePath: scope.workspacePath,
      traceId: scope.traceId,
      runId: scope.runId,
      limit,
    });
    let eventFilter = makeEventFilter();
    let eventList = this.agg.agentEvents(eventFilter);
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
      eventList = this.agg.agentEvents(eventFilter);
      event = eventList.items.find((item) => item.eventId === listedPrimaryEvent.eventId) ?? listedPrimaryEvent;
    }
    const timeline = this.agg.agentTimeline({ ...eventFilter, limit: Math.max(limit, 120) });
    const exactEventContext = Boolean(
      scope.eventId ||
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
    const incidents = this.agg.incidents({
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
    const alerts = this.alerting.list({
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
    const alertItems = new Map<string, T.AlertListItem>();
    for (const item of alerts.items) alertItems.set(item.alertId, item);

    const relatedObjectiveIds = new Set<string>();
    const addObjectiveId = (id: string | undefined) => {
      if (id) relatedObjectiveIds.add(id);
    };
    addObjectiveId(scope.objectiveId);
    for (const item of alerts.items) addObjectiveId(alertObjectiveId(item));

    const remediations = this.remediation.list({
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
    });
    const remediationItems = new Map<string, T.RemediationListItem>();
    for (const item of remediations.items) {
      remediationItems.set(item.taskId, item);
      addObjectiveId(remediationObjectiveId(item));
    }
    if (!objective && relatedObjectiveIds.size > 0) {
      const [firstObjectiveId] = [...relatedObjectiveIds];
      objective = this.objectives.list({ ...timeFilter, objectiveId: firstObjectiveId, limit: 1 }, { observe: false }).items[0];
    }
    const objectiveCandidates = this.objectives.list({ ...timeFilter, limit: 500 }, { observe: false }).items
      .filter((item) => relatedObjectiveIds.has(item.objectiveId) || objectiveMatchesScope(item, scope));
    if (objective) objectiveCandidates.unshift(objective);
    const objectiveItems = new Map<string, T.ObjectiveItem>();
    for (const item of objectiveCandidates) {
      objectiveItems.set(item.objectiveId, item);
      addObjectiveId(item.objectiveId);
    }
    for (const objectiveId of relatedObjectiveIds) {
      const objectiveAlerts = this.alerting.list({ ...timeFilter, status: 'all', kind: 'objective', objectiveId, limit }).items;
      for (const item of objectiveAlerts) alertItems.set(item.alertId, item);
    }
    for (const item of alertItems.values()) {
      if (item.kind !== 'objective') continue;
      const objectiveId = alertObjectiveId(item);
      addObjectiveId(objectiveId);
      if (objectiveId && !objectiveItems.has(objectiveId)) {
        const found = this.objectives.list({ ...timeFilter, objectiveId, limit: 1 }, { observe: false }).items[0];
        if (found) objectiveItems.set(found.objectiveId, found);
      }
      for (const task of this.remediation.list({ ...timeFilter, status: 'all', sourceType: 'alert', alertId: item.alertId, limit: 20 }).items) {
        remediationItems.set(task.taskId, task);
      }
    }
    const coverage = this.agg.coverageOverview({
      ...timeFilter,
      issueId: scope.issueId,
      sourceId: scope.sourceId,
      collectorId: scope.collectorId,
      agentId: scope.agentId,
      workspacePath: scope.workspacePath,
      limit,
    });
    const coverageIssueIds = new Set(coverage.issues.map((item) => item.issueId));
    if (coverageIssueIds.size > 0) {
      this.alerting.observeCoverageList(coverage.issues, Date.now(), { resolveMissing: false });
      for (const issueId of coverageIssueIds) {
        for (const item of this.alerting.list({ ...timeFilter, status: 'all', kind: 'coverage', issueId, limit: 20 }).items) {
          alertItems.set(item.alertId, item);
        }
        for (const item of this.remediation.list({ ...timeFilter, status: 'all', sourceType: 'coverage', issueId, limit: 20 }).items) {
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
    const bundleObjectives = sortByDateDesc([...objectiveItems.values()], (item) => item.evaluatedAt).slice(0, limit);
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
    const notificationDeliveryCandidates = sortByDateDesc([...notificationDeliveryItems.values()], (item) => item.sentAt);
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
    const maintenanceWindows = sortByDateDesc([...maintenanceItems.values()].filter((item) => maintenanceWindowMatchesScope(item, scope, { agentIds: scopedAgentIds, agentKeys: scopedAgentKeys })), (item) => item.updatedAt).slice(0, limit);
    const topology = this.agg.agentTopology({
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
    const sourceQuery: T.IngestionSourceQuery | undefined = scope.sourceId
      ? { sourceId: scope.sourceId, limit: 10 }
      : scope.collectorId
        ? { collectorId: scope.collectorId, limit: 10 }
        : scope.workspacePath
          ? { workspacePath: scope.workspacePath, limit: 10 }
          : undefined;
    const sources = sourceQuery ? this.sources.list(sourceQuery).items : [];
    const collectorItems = new Map<string, T.CollectorHealthItem>();
    const addCollector = (collectorId: string | undefined) => {
      if (!collectorId || collectorItems.has(collectorId)) return;
      const item = this.agg.collectorHealth({ ...timeFilter, collectorId, limit: 1 }).items.find((candidate) => candidate.collectorId === collectorId);
      if (item) collectorItems.set(item.collectorId, item);
    };
    addCollector(scope.collectorId);
    for (const item of sources) addCollector(item.collectorId);
    const collectors = [...collectorItems.values()].slice(0, limit);
    const agentItems = new Map<string, T.AgentInventoryItem>();
    const addAgentItem = (item: T.AgentInventoryItem) => agentItems.set(`${item.workspacePath}\0${item.agentId}`, item);
    const addAgent = (workspacePath: string | undefined, agentId: string | undefined) => {
      if (!workspacePath || !agentId || agentItems.has(`${workspacePath}\0${agentId}`)) return;
      const item = this.agg.agentInventory({ ...timeFilter, agentId, workspacePath, limit: 1 }).items.find((candidate) => candidate.agentId === agentId && candidate.workspacePath === workspacePath);
      if (item) addAgentItem(item);
    };
    if (scope.agentId) {
      for (const item of this.agg.agentInventory({ ...timeFilter, agentId: scope.agentId, workspacePath: scope.workspacePath, limit }).items) addAgentItem(item);
    } else if (scope.workspacePath && !scope.sourceId && !scope.collectorId) {
      for (const item of this.agg.agentInventory({ ...timeFilter, workspacePath: scope.workspacePath, limit }).items) addAgentItem(item);
    }
    for (const item of eventList.items) addAgent(item.workspacePath, item.agentId);
    const agents = [...agentItems.values()].slice(0, limit);
    const workspaceItems = new Map<string, T.WorkspaceInventoryItem>();
    const addWorkspace = (workspacePath: string | undefined) => {
      if (!workspacePath || workspaceItems.has(workspacePath)) return;
      const item = this.agg.workspaceInventory({ ...timeFilter, workspacePath, limit: 1 }).items.find((candidate) => candidate.workspacePath === workspacePath);
      if (item) workspaceItems.set(item.workspacePath, item);
    };
    addWorkspace(scope.workspacePath);
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
    for (const item of agents) addAudit('agent', `${item.workspacePath}:${item.agentId}`);
    const audits = [...auditItems.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);

	    const primary = {
	      ...(event ? { event } : {}),
	      ...(incident ? { incident } : {}),
	      ...(alert ? { alert } : {}),
	      ...(remediation ? { remediation } : {}),
	      ...(objective ? { objective } : {}),
	      ...(coverageIssue ? { coverageIssue } : {}),
	      ...(notificationDelivery ? { notificationDelivery } : {}),
	      ...(maintenanceWindow ? { maintenanceWindow } : {}),
	      ...(auditRecord ? { audit: auditRecord } : {}),
	      ...(topologyEdge ? { topologyEdge } : {}),
	    };
    return {
      schemaVersion: 'anysentry.evidence_bundle.v1',
      bundleId: bundleId(scope),
      generatedAt: new Date().toISOString(),
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
  evidenceExport(@Body() query: T.EvidenceBundleExportQuery = {}): T.EvidenceBundleExport {
    const bundle = this.evidenceBundle(query);
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
      content,
    };
  }

  /** Live agent-observability stream (a frame every 3s), consumed by the dashboard's SSE client. */
  @Sse('sessions/agentObservability/stream')
  @SkipWrap()
  stream(@Query() q: T.SecurityTimeFilter): Observable<{ data: T.AgentObservability }> {
    return timer(0, 3000).pipe(map(() => ({ data: this.agg.agentObservability(q) })));
  }

  /** The editable judge policy (L1 rules / L2 LLM / L3 a3s-code) + which tiers are active. The
   *  config panels read this; the dashboard hides tiers that aren't configured. */
  @Get('config')
  getConfig() {
    return this.judge.getPolicy();
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
    return updated;
  }

  @Post('config/simulate')
  @RequireManagementAuth()
  @HttpCode(200)
  simulateConfig(@Body() body: T.PolicySimulationRequest, @Headers() headers: HeaderBag) {
    let result: T.PolicySimulationResult;
    try {
      result = this.agg.policySimulation(body);
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
    const stats = this.judge.stats();
    const policy = this.judge.getPolicy();
    return {
      schemaVersion: 'anysentry.health.v1',
      status: 'ok',
      service: 'anysentry-api',
      uptimeSeconds: Math.round(process.uptime()),
      storage: this.judge.storageStatus(),
      managementAuth: {
        enabled: managementAuthConfigured(),
      },
      events: {
        total: stats.total,
        distinctAgents: stats.distinctAgents,
        distinctSessions: stats.distinctSessions,
      },
      policy: policy.status,
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

  private dispatchSecurityCapability(input: T.SecurityCapabilityRequest, headers: HeaderBag): unknown {
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
    result = this.executeSecurityCapability(input, headers);
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

  private executeSecurityCapability(input: T.SecurityCapabilityRequest, headers: HeaderBag): unknown {
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

  private executeRuntimeGuardCapability(input: T.SecurityCapabilityRequest, headers: HeaderBag): T.SecurityRuntimeGuardDecision {
    const body = securityRuntimeGuardParams(input.params);
    const autonomy = securityCapabilityAutonomy(body.autonomy ?? input.constraints?.autonomy);
    const stage = securityCapabilityStage(body.stage);
    const event = securityRuntimeGuardEvent(body, autonomy, stage);
    const result = this.ingestUniversalEvents(
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
    );
    const item = result.items[0];
    const fallbackRisk = securityRuntimeGuardFallbackRisk(body, event);
    const basePolicyAction = securityCapabilityPolicyAction(autonomy, item);
    const policyAction = securityCapabilityPolicyAction(autonomy, item, fallbackRisk);
    let evidenceItem = item;
    if (fallbackRisk && policyActionRank(policyAction) > policyActionRank(basePolicyAction)) {
      const finding = this.ingestUniversalEvents(
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
  ingestEvents(@Body() body: T.UniversalIngestBody = {}, @Headers() headers: HeaderBag): T.UniversalIngestResult {
    const normalized = normalizeUniversalIngestBody(body, headers);
    return this.ingestUniversalEvents(normalized, headers, normalized.sourceType ?? 'custom', 'ingest/events');
  }

  /** Native OTLP/HTTP JSON ingress: accepts resourceLogs/resourceSpans and normalizes them. */
  @Post('ingest/otel')
  ingestOtel(@Body() body: T.UniversalIngestRequest & Record<string, unknown> = {}, @Headers() headers: HeaderBag): T.UniversalIngestResult {
    return this.ingestUniversalEvents(otlpToUniversal(body), headers, 'otel', 'ingest/otel');
  }

  /** OTLP/HTTP logs endpoint shape: set exporter base URL to /security-center/ingest/otlp. */
  @Post('ingest/otlp/v1/logs')
  ingestOtlpLogs(@Body() body: T.UniversalIngestRequest & Record<string, unknown> = {}, @Headers() headers: HeaderBag): T.UniversalIngestResult {
    return this.ingestUniversalEvents(otlpToUniversal(body), headers, 'otel', 'ingest/otlp/v1/logs');
  }

  /** OTLP/HTTP traces endpoint shape: set exporter base URL to /security-center/ingest/otlp. */
  @Post('ingest/otlp/v1/traces')
  ingestOtlpTraces(@Body() body: T.UniversalIngestRequest & Record<string, unknown> = {}, @Headers() headers: HeaderBag): T.UniversalIngestResult {
    return this.ingestUniversalEvents(otlpToUniversal(body), headers, 'otel', 'ingest/otlp/v1/traces');
  }

  private ingestUniversalEvents(body: T.UniversalIngestRequest, headers: HeaderBag, fallbackType: T.IngestionSourceType, endpoint: string): T.UniversalIngestResult {
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
      const kind = canonicalEventKind(input);
      const line = universalEventLine(kind, input, defaults);
      const partial = universalMeta(input, defaults, sourceResolution.source?.sourceId);
      const meta = deriveMeta(line, {
        ...partial,
        eventKind: kind,
        eventCategory: partial.eventCategory ?? eventCategory(kind),
      });
      const rec = this.judge.judge(line, meta, eventTime(input));
      if (!rec) {
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
      this.sources.recordAccepted(sourceResolution, 'event', { collectorId: inputCollectorId, workspacePath: rec.workspacePath });
      acceptedEvents += 1;
      items.push({
        index,
        accepted: true,
        eventId: rec.eventId,
        traceId: rec.traceId,
        spanId: rec.spanId,
        runId: rec.runId,
        verdict: rec.verdict,
        tier: rec.tier,
        severity: rec.severity,
        riskCategory: rec.riskCategory,
      });
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

  /** The real ingestion seam: external agents/observers POST events here to be judged + counted. */
  @Post('ingest')
  ingest(@Body() body: IngestBody, @Headers() headers: HeaderBag) {
    const { line, collectorId, nodeName, sourceId, sourceName, sourceType, token, ...given } = body;
    const heartbeat = parseCollectorHeartbeatLine(line);
    const requestSourceId = sourceId ?? headerValue(headers, 'x-anysentry-source-id');
    const requestToken = token ?? headerValue(headers, 'x-anysentry-ingest-token') ?? bearerToken(headers);
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
    if (heartbeat) {
      const rec = this.judge.recordCollectorHeartbeat({
        ...heartbeat,
        collectorId: heartbeat.collectorId ?? requestCollectorId ?? sourceResolution.source?.collectorId,
        nodeName: heartbeat.nodeName ?? nodeName,
      });
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
      attributes: {
        ...(given.attributes ?? {}),
        ...(collectorId ? { collectorId } : {}),
        ...(nodeName ? { collectorNode: nodeName } : {}),
        ...(sourceResolution.source?.sourceId ? { sourceId: sourceResolution.source.sourceId } : {}),
      },
    };
    // Enrich identity (pod-uid → real agent name) and focus on agent workloads (drop infra/host).
    const meta = this.kube.enrich(deriveMeta(line, metaGiven));
    if (!meta) {
      this.recordRejectedIngest(sourceResolution, 'filtered: infra/host (not an agent workload)', {
        sourceId: requestSourceId,
        sourceName,
        sourceType,
        collectorId,
        nodeName,
        workspacePath: given.workspacePath,
        endpoint: 'ingest',
        rejectedEvents: 1,
      });
      return { accepted: false, sourceId: sourceResolution.source?.sourceId, reason: 'filtered: infra/host (not an agent workload)' };
    }
    const rec = this.judge.judge(line, meta);
    if (!rec) {
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
      return { accepted: false, sourceId: sourceResolution.source?.sourceId, reason: 'unparseable event' };
    }
    this.sources.recordAccepted(sourceResolution, 'event', { collectorId, workspacePath: rec.workspacePath });
    this.agg.invalidateWindowCache();
    return { accepted: true, sourceId: sourceResolution.source?.sourceId, eventId: rec.eventId, traceId: rec.traceId, spanId: rec.spanId, runId: rec.runId, verdict: rec.verdict, tier: rec.tier, severity: rec.severity, reason: rec.reason, riskCategory: rec.riskCategory };
  }
}
