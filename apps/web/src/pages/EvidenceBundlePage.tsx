import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  AlertTriangle,
  ArrowLeft,
  BellRing,
  Bot,
  CalendarClock,
  Clock3,
  Download,
  FileCheck2,
  FileText,
  GitBranch,
  History,
  LoaderCircle,
  PlugZap,
  RadioTower,
  RefreshCw,
  ScrollText,
  Search,
  Send,
  ShieldAlert,
  Target,
  TerminalSquare,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type AgentEventListItem,
  type AgentInventoryItem,
  type AgentTopologyEdge,
  type AlertListItem,
  type AuditListItem,
  type CollectorHealthItem,
  type CoverageIssue,
  type EvidenceBundle,
  type EvidenceBundlePrimaryType,
  type EvidenceBundleQuery,
  type EvidenceBundleScope,
  type IncidentListItem,
  type IngestionSourceItem,
  type MaintenanceWindowItem,
  type NotificationDeliveryItem,
  type ObjectiveItem,
  type RemediationListItem,
  type SecuritySeverity,
  type SecurityTimeType,
  type WorkspaceInventoryItem,
  securityCenterApi,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";

const TIME_OPTIONS: Array<{ value: SecurityTimeType; label: string }> = [
  { value: "last_3h", label: "近3小时" },
  { value: "last_1d", label: "近一天" },
  { value: "last_7d", label: "近一周" },
  { value: "last_30d", label: "近一月" },
];

const PRIMARY_LABEL: Record<EvidenceBundlePrimaryType, string> = {
  event: "Event",
  incident: "Incident",
  alert: "Alert",
  remediation: "Remediation",
  objective: "Objective",
  coverage: "Coverage",
  notification: "Notification",
  maintenance: "Maintenance",
  audit: "Audit",
  topology: "Topology",
  scope: "Scope",
};

const SEVERITY_LABEL: Record<SecuritySeverity, string> = {
  info: "提示",
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
};

function clean(value: string) {
  return value.trim() || undefined;
}

function downloadText(filename: string, content: string, contentType: string) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function formatDate(value?: string) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function shortId(value?: string) {
  if (!value) return "--";
  return value.length > 26 ? `${value.slice(0, 12)}...${value.slice(-8)}` : value;
}

function deliveryRelation(item: NotificationDeliveryItem) {
  return [
    item.incidentId ? `incident:${shortId(item.incidentId)}` : undefined,
    item.eventId ? `event:${shortId(item.eventId)}` : undefined,
    item.taskId ? `task:${shortId(item.taskId)}` : undefined,
    item.objectiveId ? `objective:${shortId(item.objectiveId)}` : undefined,
    item.issueId ? `coverage:${shortId(item.issueId)}` : undefined,
  ].filter(Boolean).join(" / ");
}

function severityTone(severity?: SecuritySeverity) {
  if (severity === "critical" || severity === "high") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (severity === "medium") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (severity === "low") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function statusTone(value?: string) {
  if (!value) return "border-white/10 bg-white/5 text-zinc-300";
  if (["open", "blocked", "error", "down", "critical"].includes(value)) return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (["acknowledged", "in_progress", "silenced", "degraded", "stale"].includes(value)) return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (["resolved", "done", "ok", "healthy", "active", "success"].includes(value)) return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function Pill({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", className)}>
      {children}
    </span>
  );
}

function FieldValue({ label, value }: { label: string; value?: string | number }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-zinc-600">{label}</p>
      <p className="mt-1 truncate font-mono text-xs text-zinc-300" title={String(value ?? "")}>
        {value ?? "--"}
      </p>
    </div>
  );
}

function MetricTile({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className={cn("rounded-[8px] border px-4 py-3", tone)}>
      <p className="text-xs opacity-80">{label}</p>
      <p className="mt-1 truncate font-mono text-2xl font-semibold">{value}</p>
    </div>
  );
}

function Panel({
  title,
  icon,
  count,
  children,
  className,
}: {
  title: string;
  icon: ReactNode;
  count?: number | string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-[8px] border border-white/10 bg-[#111612]/92", className)}>
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {icon}
          <h2 className="truncate text-sm font-semibold text-zinc-100">{title}</h2>
        </div>
        {count !== undefined ? <span className="shrink-0 text-xs text-zinc-500">{count}</span> : null}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ children }: { children: string }) {
  return <div className="flex min-h-24 items-center justify-center px-4 py-6 text-sm text-zinc-500">{children}</div>;
}

function RecordLink({
  icon,
  title,
  subtitle,
  href,
  tag,
  tagClassName,
  meta,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  href: string;
  tag?: string;
  tagClassName?: string;
  meta?: string;
}) {
  return (
    <Link
      to={href}
      className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 border-b border-white/8 px-4 py-3 transition hover:bg-white/[0.05]"
    >
      <span className="text-zinc-400">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={title}>{title}</span>
        {subtitle ? <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={subtitle}>{subtitle}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {meta ? <span className="hidden font-mono text-[11px] text-zinc-600 sm:inline">{meta}</span> : null}
        {tag ? <Pill className={tagClassName}>{tag}</Pill> : null}
      </span>
    </Link>
  );
}

function queryString(entries: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  Object.entries(entries).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return params.toString();
}

function eventHref(event: AgentEventListItem) {
  return `/events?${queryString({
    eventId: event.eventId,
    traceId: event.traceId,
    agentId: event.agentId,
    workspacePath: event.workspacePath,
    sessionId: event.sessionId,
  })}`;
}

function incidentHref(incident: IncidentListItem) {
  return `/incidents?${queryString({
    incidentId: incident.incidentId,
    traceId: incident.traceId,
    agentId: incident.agentId,
    workspacePath: incident.workspacePath,
    sessionId: incident.sessionId,
  })}`;
}

function alertHref(alert: AlertListItem) {
  return `/alerts?${queryString({
    alertId: alert.alertId,
    incidentId: alert.incidentId,
    workspacePath: alert.workspacePath,
    agentId: alert.agentId,
    collectorId: alert.collectorId,
    sourceId: alert.sourceId,
  })}`;
}

function remediationHref(task: RemediationListItem) {
  return `/remediation?${queryString({
    taskId: task.taskId,
    incidentId: task.incidentId,
    alertId: task.alertId,
    eventId: task.eventId,
    objectiveId: task.labels?.objectiveId,
    issueId: task.sourceType === "coverage" ? task.sourceId : task.labels?.issueId,
    agentId: task.agentId,
    collectorId: task.collectorId,
    sourceId: task.ingestionSourceId,
    workspacePath: task.workspacePath,
  })}`;
}

function objectiveTargetScope(objective: ObjectiveItem): Pick<EvidenceBundleScope, "agentId" | "workspacePath" | "collectorId" | "sourceId"> {
  const targetId = objective.targetId?.trim();
  if (!targetId) return {};
  if (objective.targetType === "workspace") return { workspacePath: targetId };
  if (objective.targetType === "agent") return splitAgentTargetId(targetId);
  if (objective.targetType === "collector") return { collectorId: targetId };
  if (objective.targetType === "source") return { sourceId: targetId };
  return {};
}

function objectiveHref(objective: ObjectiveItem) {
  const scope = objectiveTargetScope(objective);
  return `/objectives?${queryString({
    objectiveId: objective.objectiveId,
    targetType: objective.targetType,
    targetId: objective.targetId,
    metric: objective.metric,
    agentId: scope.agentId,
    workspacePath: scope.workspacePath,
    collectorId: scope.collectorId,
    sourceId: scope.sourceId,
  })}`;
}

function coverageHref(issue: CoverageIssue) {
  return `/coverage?${queryString({
    issueId: issue.issueId,
    agentId: issue.agentId,
    collectorId: issue.collectorId,
    sourceId: issue.sourceId,
    workspacePath: issue.workspacePath,
  })}`;
}

function maintenanceHref(window: MaintenanceWindowItem) {
  return `/maintenance?${queryString({
    windowId: window.windowId,
    targetType: window.targetType,
    targetId: window.targetId,
  })}`;
}

function maintenanceEvidenceHref(window: MaintenanceWindowItem, timeType: SecurityTimeType) {
  const agentScope = window.targetType === "agent" ? splitAgentTargetId(window.targetId) : undefined;
  return `/evidence?${queryString({
    timeType,
    windowId: window.windowId,
    workspacePath: window.targetType === "workspace" ? window.targetId : undefined,
    agentId: agentScope?.agentId,
    ...(agentScope?.workspacePath ? { workspacePath: agentScope.workspacePath } : {}),
    collectorId: window.targetType === "collector" ? window.targetId : undefined,
    sourceId: window.targetType === "source" ? window.targetId : undefined,
  })}`;
}

function splitAgentTargetId(targetId: string) {
  const separator = targetId.lastIndexOf(":");
  if (separator <= 0 || separator >= targetId.length - 1) return { agentId: targetId };
  return {
    workspacePath: targetId.slice(0, separator),
    agentId: targetId.slice(separator + 1),
  };
}

function auditHref(audit: AuditListItem) {
  return `/audit?${queryString({ auditId: audit.auditId, resourceId: audit.resourceId })}`;
}

function auditEvidenceHref(audit: AuditListItem, timeType: SecurityTimeType) {
  return `/evidence?${queryString({
    timeType,
    auditId: audit.auditId,
    eventId: typeof audit.details?.eventId === "string" ? audit.details.eventId : undefined,
    edgeId: typeof audit.details?.edgeId === "string" ? audit.details.edgeId : undefined,
    incidentId: audit.resourceType === "incident" ? audit.resourceId : typeof audit.details?.incidentId === "string" ? audit.details.incidentId : undefined,
    alertId: audit.resourceType === "alert" ? audit.resourceId : typeof audit.details?.alertId === "string" ? audit.details.alertId : undefined,
    taskId: audit.resourceType === "remediation" ? audit.resourceId : typeof audit.details?.taskId === "string" ? audit.details.taskId : undefined,
    objectiveId: audit.resourceType === "objective" ? audit.resourceId : typeof audit.details?.objectiveId === "string" ? audit.details.objectiveId : undefined,
    issueId: typeof audit.details?.issueId === "string" ? audit.details.issueId : undefined,
    deliveryId: typeof audit.details?.deliveryId === "string" ? audit.details.deliveryId : audit.resourceType === "notification" && audit.action === "notification.delivery_failed" ? audit.resourceId : undefined,
    windowId: audit.resourceType === "maintenance" ? audit.resourceId : typeof audit.details?.windowId === "string" ? audit.details.windowId : undefined,
    workspacePath: typeof audit.details?.workspacePath === "string" ? audit.details.workspacePath : undefined,
    agentId: typeof audit.details?.agentId === "string" ? audit.details.agentId : undefined,
    collectorId: typeof audit.details?.collectorId === "string" ? audit.details.collectorId : undefined,
    sourceId: audit.resourceType === "source" ? audit.resourceId : typeof audit.details?.sourceId === "string" ? audit.details.sourceId : undefined,
  })}`;
}

function notificationHref(delivery: NotificationDeliveryItem) {
  return `/notifications?${queryString({
    deliveryId: delivery.deliveryId,
    alertId: delivery.alertId,
    incidentId: delivery.incidentId,
    eventId: delivery.eventId,
    taskId: delivery.taskId,
    objectiveId: delivery.objectiveId,
    issueId: delivery.issueId,
    channelId: delivery.channelId,
    routeId: delivery.routeId,
  })}`;
}

function notificationEvidenceHref(delivery: NotificationDeliveryItem, timeType: SecurityTimeType) {
  return `/evidence?${queryString({
    timeType,
    deliveryId: delivery.deliveryId,
    alertId: delivery.alertId,
    incidentId: delivery.incidentId,
    eventId: delivery.eventId,
    taskId: delivery.taskId,
    objectiveId: delivery.objectiveId,
    issueId: delivery.issueId,
    workspacePath: delivery.workspacePath,
    agentId: delivery.agentId,
    collectorId: delivery.collectorId,
    sourceId: delivery.sourceId,
  })}`;
}

function agentHref(agent: AgentInventoryItem) {
  return `/agents?${queryString({ agentId: agent.agentId, workspacePath: agent.workspacePath })}`;
}

function workspaceHref(workspace: WorkspaceInventoryItem) {
  return `/workspaces?${queryString({ workspacePath: workspace.workspacePath })}`;
}

function sourceHref(source: IngestionSourceItem) {
  return `/sources?${queryString({ sourceId: source.sourceId, collectorId: source.collectorId, workspacePath: source.workspacePath })}`;
}

function collectorHref(collector: CollectorHealthItem) {
  return `/collectors?${queryString({ collectorId: collector.collectorId })}`;
}

function topologyHref(bundle: EvidenceBundle) {
  return `/topology?${queryString({
    edgeId: bundle.scope.edgeId,
    eventId: bundle.scope.eventId,
    agentId: bundle.scope.agentId,
    collectorId: bundle.scope.collectorId,
    sourceId: bundle.scope.sourceId,
    workspacePath: bundle.scope.workspacePath,
  })}`;
}

function topologyEdgeEvidenceHref(edge: AgentTopologyEdge, timeType: SecurityTimeType, scope: EvidenceBundleScope) {
  return `/evidence?${queryString({
    timeType,
    edgeId: edge.edgeId,
    eventId: edge.sampleEventId,
    agentId: scope.agentId,
    workspacePath: scope.workspacePath,
    collectorId: scope.collectorId,
    sourceId: scope.sourceId,
  })}`;
}

function PrimaryPanel({ bundle }: { bundle: EvidenceBundle }) {
  const { primary } = bundle;
  if (bundle.scope.primaryType === "notification" && primary.notificationDelivery) {
    return (
      <Panel title="Primary Evidence" icon={<FileText className="size-4 text-teal-200" />}>
        <RecordLink
          icon={<Send className="size-4" />}
          title={primary.notificationDelivery.alertTitle}
          subtitle={`${primary.notificationDelivery.action} / ${shortId(primary.notificationDelivery.deliveryId)}`}
          href={notificationHref(primary.notificationDelivery)}
          tag={primary.notificationDelivery.status}
          tagClassName={statusTone(primary.notificationDelivery.status)}
          meta={formatDate(primary.notificationDelivery.sentAt)}
        />
      </Panel>
    );
  }
  if (bundle.scope.primaryType === "maintenance" && primary.maintenanceWindow) {
    return (
      <Panel title="Primary Evidence" icon={<FileText className="size-4 text-teal-200" />}>
        <RecordLink
          icon={<CalendarClock className="size-4" />}
          title={primary.maintenanceWindow.title}
          subtitle={`${primary.maintenanceWindow.targetType}:${primary.maintenanceWindow.targetId} / ${shortId(primary.maintenanceWindow.windowId)}`}
          href={maintenanceHref(primary.maintenanceWindow)}
          tag={primary.maintenanceWindow.status}
          tagClassName={statusTone(primary.maintenanceWindow.status)}
          meta={`${formatDate(primary.maintenanceWindow.startAt)} - ${formatDate(primary.maintenanceWindow.endAt)}`}
        />
      </Panel>
    );
  }
  if (bundle.scope.primaryType === "audit" && primary.audit) {
    return (
      <Panel title="Primary Evidence" icon={<FileText className="size-4 text-teal-200" />}>
        <RecordLink
          icon={<History className="size-4" />}
          title={primary.audit.summary}
          subtitle={`${primary.audit.action} / ${primary.audit.resourceType}:${shortId(primary.audit.resourceId)}`}
          href={auditHref(primary.audit)}
          tag={primary.audit.result}
          tagClassName={statusTone(primary.audit.result)}
          meta={formatDate(primary.audit.at)}
        />
      </Panel>
    );
  }
  if (bundle.scope.primaryType === "topology" && primary.topologyEdge) {
    return (
      <Panel title="Primary Evidence" icon={<FileText className="size-4 text-teal-200" />}>
        <RecordLink
          icon={<GitBranch className="size-4" />}
          title={primary.topologyEdge.label}
          subtitle={`${primary.topologyEdge.type} / ${shortId(primary.topologyEdge.edgeId)} / sample:${shortId(primary.topologyEdge.sampleEventId)}`}
          href={topologyHref(bundle)}
          tag={SEVERITY_LABEL[primary.topologyEdge.maxSeverity]}
          tagClassName={severityTone(primary.topologyEdge.maxSeverity)}
          meta={formatDate(primary.topologyEdge.lastSeen)}
        />
      </Panel>
    );
  }
  if (primary.event) {
    return (
      <Panel title="Primary Evidence" icon={<FileText className="size-4 text-teal-200" />}>
        <RecordLink
          icon={<TerminalSquare className="size-4" />}
          title={primary.event.subject}
          subtitle={`${primary.event.agentId} / ${shortId(primary.event.traceId)}`}
          href={eventHref(primary.event)}
          tag={SEVERITY_LABEL[primary.event.severity]}
          tagClassName={severityTone(primary.event.severity)}
          meta={formatDate(primary.event.at)}
        />
      </Panel>
    );
  }
  if (primary.incident) {
    return (
      <Panel title="Primary Evidence" icon={<FileText className="size-4 text-teal-200" />}>
        <RecordLink
          icon={<ShieldAlert className="size-4" />}
          title={primary.incident.title}
          subtitle={`${primary.incident.agentId} / ${shortId(primary.incident.incidentId)}`}
          href={incidentHref(primary.incident)}
          tag={primary.incident.status}
          tagClassName={statusTone(primary.incident.status)}
          meta={formatDate(primary.incident.updatedAt)}
        />
      </Panel>
    );
  }
  if (primary.alert) {
    return (
      <Panel title="Primary Evidence" icon={<FileText className="size-4 text-teal-200" />}>
        <RecordLink
          icon={<BellRing className="size-4" />}
          title={primary.alert.title}
          subtitle={`${primary.alert.kind} / ${shortId(primary.alert.alertId)}`}
          href={alertHref(primary.alert)}
          tag={primary.alert.status}
          tagClassName={statusTone(primary.alert.status)}
          meta={formatDate(primary.alert.lastSeenAt)}
        />
      </Panel>
    );
  }
  if (primary.remediation) {
    return (
      <Panel title="Primary Evidence" icon={<FileText className="size-4 text-teal-200" />}>
        <RecordLink
          icon={<FileCheck2 className="size-4" />}
          title={primary.remediation.title}
          subtitle={`${primary.remediation.sourceType}:${shortId(primary.remediation.sourceId)}`}
          href={remediationHref(primary.remediation)}
          tag={primary.remediation.status}
          tagClassName={statusTone(primary.remediation.status)}
          meta={formatDate(primary.remediation.updatedAt)}
        />
      </Panel>
    );
  }
  if (primary.objective) {
    return (
      <Panel title="Primary Evidence" icon={<FileText className="size-4 text-teal-200" />}>
        <RecordLink
          icon={<Target className="size-4" />}
          title={primary.objective.name}
          subtitle={`${primary.objective.targetType}:${primary.objective.targetId ?? "*"} / ${primary.objective.metric}`}
          href={objectiveHref(primary.objective)}
          tag={primary.objective.status}
          tagClassName={statusTone(primary.objective.status)}
          meta={formatDate(primary.objective.evaluatedAt)}
        />
      </Panel>
    );
  }
  if (primary.coverageIssue) {
    return (
      <Panel title="Primary Evidence" icon={<FileText className="size-4 text-teal-200" />}>
        <RecordLink
          icon={<RadioTower className="size-4" />}
          title={primary.coverageIssue.title}
          subtitle={`${primary.coverageIssue.type} / ${shortId(primary.coverageIssue.issueId)}`}
          href={coverageHref(primary.coverageIssue)}
          tag={SEVERITY_LABEL[primary.coverageIssue.severity]}
          tagClassName={severityTone(primary.coverageIssue.severity)}
          meta={formatDate(primary.coverageIssue.lastSeenAt ?? primary.coverageIssue.detectedAt)}
        />
      </Panel>
    );
  }
  return (
    <Panel title="Primary Evidence" icon={<FileText className="size-4 text-teal-200" />}>
      <EmptyState>当前证据包来自范围查询</EmptyState>
    </Panel>
  );
}

function ScopePanel({ bundle }: { bundle: EvidenceBundle }) {
  const entries = Object.entries(bundle.scope)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => [key, key === "primaryType" ? PRIMARY_LABEL[value as EvidenceBundlePrimaryType] : String(value)] as const);

  return (
    <Panel title="Scope" icon={<Search className="size-4 text-teal-200" />} count={PRIMARY_LABEL[bundle.scope.primaryType]}>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <FieldValue label="Bundle ID" value={bundle.bundleId} />
        <FieldValue label="Generated" value={formatDate(bundle.generatedAt)} />
        {entries.map(([key, value]) => <FieldValue key={key} label={key} value={value} />)}
      </div>
    </Panel>
  );
}

function RiskPanel({ bundle }: { bundle: EvidenceBundle }) {
  return (
    <Panel title="Risk Categories" icon={<AlertTriangle className="size-4 text-amber-200" />} count={bundle.summary.riskCategories.length}>
      {bundle.summary.riskCategories.length === 0 ? (
        <EmptyState>暂无风险分类</EmptyState>
      ) : (
        <div className="divide-y divide-white/8">
          {bundle.summary.riskCategories.map((item) => (
            <div key={`${item.riskCategory}:${item.riskName}`} className="grid grid-cols-[minmax(0,1fr)_52px] gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-100" title={item.riskName}>{item.riskName}</p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-600" title={item.riskCategory}>{item.riskCategory}</p>
              </div>
              <span className="font-mono text-sm text-zinc-300">{item.eventCount}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function TimelinePanel({ bundle }: { bundle: EvidenceBundle }) {
  const items = bundle.timeline.items ?? [];
  return (
    <Panel title="Trace Timeline" icon={<GitBranch className="size-4 text-teal-200" />} count={items.length}>
      {items.length === 0 ? (
        <EmptyState>暂无 Trace 时间线</EmptyState>
      ) : (
        <div className="max-h-[520px] overflow-y-auto p-4">
          <div className="space-y-3">
            {items.map((event, index) => (
              <div key={event.eventId} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                <div className="flex flex-col items-center">
                  <span className="flex size-6 items-center justify-center rounded-full border border-teal-400/30 bg-teal-500/10 font-mono text-[10px] text-teal-100">
                    {index + 1}
                  </span>
                  {index < items.length - 1 ? <span className="mt-1 h-full min-h-8 w-px bg-white/10" /> : null}
                </div>
                <Link to={eventHref(event)} className="min-w-0 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 transition hover:bg-white/[0.06]">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-sm font-medium text-zinc-100" title={event.subject}>{event.subject}</p>
                    <span className="shrink-0 font-mono text-[11px] text-zinc-500">{formatDate(event.at)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Pill className={severityTone(event.severity)}>{SEVERITY_LABEL[event.severity]}</Pill>
                    <span className="font-mono text-[11px] text-zinc-600">{shortId(event.spanId)}</span>
                  </div>
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

function EventsPanel({ events }: { events: AgentEventListItem[] }) {
  return (
    <Panel title="Events" icon={<TerminalSquare className="size-4 text-teal-200" />} count={events.length}>
      {events.length === 0 ? (
        <EmptyState>暂无事件</EmptyState>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          {events.map((event) => (
            <RecordLink
              key={event.eventId}
              icon={<TerminalSquare className="size-4" />}
              title={event.subject}
              subtitle={`${event.agentId} / ${shortId(event.traceId)}`}
              href={eventHref(event)}
              tag={SEVERITY_LABEL[event.severity]}
              tagClassName={severityTone(event.severity)}
              meta={formatDate(event.at)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function IncidentsPanel({ incidents }: { incidents: IncidentListItem[] }) {
  return (
    <Panel title="Incidents" icon={<ShieldAlert className="size-4 text-rose-200" />} count={incidents.length}>
      {incidents.length === 0 ? (
        <EmptyState>暂无 Incident</EmptyState>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          {incidents.map((incident) => (
            <RecordLink
              key={incident.incidentId}
              icon={<ShieldAlert className="size-4" />}
              title={incident.title}
              subtitle={`${incident.agentId} / ${shortId(incident.traceId)}`}
              href={incidentHref(incident)}
              tag={incident.status}
              tagClassName={statusTone(incident.status)}
              meta={formatDate(incident.updatedAt)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function AlertsPanel({ alerts }: { alerts: AlertListItem[] }) {
  return (
    <Panel title="Alerts" icon={<BellRing className="size-4 text-sky-200" />} count={alerts.length}>
      {alerts.length === 0 ? (
        <EmptyState>暂无告警</EmptyState>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          {alerts.map((alert) => (
            <RecordLink
              key={alert.alertId}
              icon={<BellRing className="size-4" />}
              title={alert.title}
              subtitle={`${alert.kind} / ${shortId(alert.alertId)}`}
              href={alertHref(alert)}
              tag={alert.status}
              tagClassName={statusTone(alert.status)}
              meta={formatDate(alert.lastSeenAt)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function RemediationsPanel({ remediations }: { remediations: RemediationListItem[] }) {
  return (
    <Panel title="Remediation" icon={<FileCheck2 className="size-4 text-teal-200" />} count={remediations.length}>
      {remediations.length === 0 ? (
        <EmptyState>暂无处置任务</EmptyState>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          {remediations.map((task) => (
            <RecordLink
              key={task.taskId}
              icon={<FileCheck2 className="size-4" />}
              title={task.title}
              subtitle={`${task.sourceType}:${shortId(task.sourceId)}`}
              href={remediationHref(task)}
              tag={task.status}
              tagClassName={statusTone(task.status)}
              meta={formatDate(task.updatedAt)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function ObjectivesPanel({ objectives }: { objectives: ObjectiveItem[] }) {
  return (
    <Panel title="Objectives" icon={<Target className="size-4 text-orange-200" />} count={objectives.length}>
      {objectives.length === 0 ? (
        <EmptyState>暂无关联目标</EmptyState>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          {objectives.map((objective) => (
            <RecordLink
              key={objective.objectiveId}
              icon={<Target className="size-4" />}
              title={objective.name}
              subtitle={`${objective.targetType}:${objective.targetId ?? "*"} / ${objective.metric}=${objective.currentValue}`}
              href={objectiveHref(objective)}
              tag={objective.status}
              tagClassName={statusTone(objective.status)}
              meta={formatDate(objective.evaluatedAt)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function CoveragePanel({ issues }: { issues: CoverageIssue[] }) {
  return (
    <Panel title="Coverage" icon={<Bot className="size-4 text-violet-200" />} count={issues.length}>
      {issues.length === 0 ? (
        <EmptyState>暂无覆盖面问题</EmptyState>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          {issues.map((issue) => (
            <RecordLink
              key={issue.issueId}
              icon={<Bot className="size-4" />}
              title={issue.title}
              subtitle={issue.description}
              href={coverageHref(issue)}
              tag={SEVERITY_LABEL[issue.severity]}
              tagClassName={severityTone(issue.severity)}
              meta={formatDate(issue.lastSeenAt ?? issue.detectedAt)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function NotificationDeliveryRow({ delivery, timeType }: { delivery: NotificationDeliveryItem; timeType: SecurityTimeType }) {
  const relation = deliveryRelation(delivery);
  const subtitle = `${delivery.action} / ${delivery.channelName} / ${delivery.routeName ?? delivery.routeId ?? "fallback"}${relation ? ` / ${relation}` : ""} / ${shortId(delivery.deliveryId)}`;
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 border-b border-white/8 px-4 py-3 transition hover:bg-white/[0.05] sm:grid-cols-[22px_minmax(0,1fr)_auto_auto]">
      <span className="text-zinc-400"><Send className="size-4" /></span>
      <Link to={notificationHref(delivery)} className="min-w-0 rounded-sm transition hover:text-teal-100">
        <span className="block truncate text-sm font-medium text-zinc-100" title={delivery.alertTitle}>{delivery.alertTitle}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={subtitle}>{subtitle}</span>
      </Link>
      <span className="flex shrink-0 items-center gap-2">
        <span className="hidden font-mono text-[11px] text-zinc-600 sm:inline">{formatDate(delivery.sentAt)}</span>
        <Pill className={statusTone(delivery.status)}>{delivery.status}</Pill>
      </span>
      <Button asChild variant="secondary" size="sm" className="col-start-2 h-8 w-fit border border-white/10 bg-white/5 px-2 text-zinc-100 hover:bg-white/10 sm:col-start-auto">
        <Link to={notificationEvidenceHref(delivery, timeType)} title="以此投递打开证据包" aria-label={`以投递 ${delivery.deliveryId} 打开证据包`}>
          <FileText className="size-3.5" />
          证据包
        </Link>
      </Button>
    </div>
  );
}

function NotificationDeliveriesPanel({ deliveries, timeType }: { deliveries: NotificationDeliveryItem[]; timeType: SecurityTimeType }) {
  return (
    <Panel title="Notification Deliveries" icon={<Send className="size-4 text-violet-200" />} count={deliveries.length}>
      {deliveries.length === 0 ? (
        <EmptyState>暂无通知投递记录</EmptyState>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          {deliveries.map((delivery) => <NotificationDeliveryRow key={delivery.deliveryId} delivery={delivery} timeType={timeType} />)}
        </div>
      )}
    </Panel>
  );
}

function MaintenanceWindowRow({ window, timeType }: { window: MaintenanceWindowItem; timeType: SecurityTimeType }) {
  const subtitle = `${window.targetType}:${window.targetId} / ${shortId(window.windowId)}${window.reason ? ` / ${window.reason}` : ""}`;
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 border-b border-white/8 px-4 py-3 transition hover:bg-white/[0.05] sm:grid-cols-[22px_minmax(0,1fr)_auto_auto]">
      <span className="text-zinc-400"><CalendarClock className="size-4" /></span>
      <Link to={maintenanceHref(window)} className="min-w-0 rounded-sm transition hover:text-teal-100">
        <span className="block truncate text-sm font-medium text-zinc-100" title={window.title}>{window.title}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={subtitle}>{subtitle}</span>
      </Link>
      <span className="flex shrink-0 items-center gap-2">
        <span className="hidden font-mono text-[11px] text-zinc-600 sm:inline">{formatDate(window.startAt)} - {formatDate(window.endAt)}</span>
        <Pill className={statusTone(window.status)}>{window.status}</Pill>
      </span>
      <Button asChild variant="secondary" size="sm" className="col-start-2 h-8 w-fit border border-white/10 bg-white/5 px-2 text-zinc-100 hover:bg-white/10 sm:col-start-auto">
        <Link to={maintenanceEvidenceHref(window, timeType)} title="以此维护窗口打开证据包" aria-label={`以维护窗口 ${window.windowId} 打开证据包`}>
          <FileText className="size-3.5" />
          证据包
        </Link>
      </Button>
    </div>
  );
}

function MaintenanceWindowsPanel({ windows, timeType }: { windows: MaintenanceWindowItem[]; timeType: SecurityTimeType }) {
  return (
    <Panel title="Maintenance Windows" icon={<CalendarClock className="size-4 text-indigo-200" />} count={windows.length}>
      {windows.length === 0 ? (
        <EmptyState>暂无维护窗口</EmptyState>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          {windows.map((window) => <MaintenanceWindowRow key={window.windowId} window={window} timeType={timeType} />)}
        </div>
      )}
    </Panel>
  );
}

function TopologyPanel({ bundle, timeType }: { bundle: EvidenceBundle; timeType: SecurityTimeType }) {
  const { topology } = bundle;
  return (
    <Panel title="Topology" icon={<GitBranch className="size-4 text-teal-200" />} count={`${topology.nodes.length}/${topology.edges.length}`}>
      {topology.edges.length === 0 ? (
        <EmptyState>暂无拓扑边</EmptyState>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          {topology.edges.map((edge) => (
            <div
              key={edge.edgeId}
              className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 border-b border-white/8 px-4 py-3 transition hover:bg-white/[0.05] sm:grid-cols-[22px_minmax(0,1fr)_auto_auto]"
            >
              <span className="text-zinc-400"><GitBranch className="size-4" /></span>
              <Link to={topologyHref({ ...bundle, scope: { ...bundle.scope, edgeId: edge.edgeId, eventId: edge.sampleEventId } })} className="min-w-0 rounded-sm transition hover:text-teal-100">
                <span className="block truncate text-sm font-medium text-zinc-100" title={edge.label}>{edge.label}</span>
                <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={edge.sampleSubject}>{edge.type} / {shortId(edge.edgeId)}</span>
              </Link>
              <Pill className={severityTone(edge.maxSeverity)}>{SEVERITY_LABEL[edge.maxSeverity]}</Pill>
              <Button asChild variant="secondary" size="sm" className="col-start-2 h-8 w-fit border border-white/10 bg-white/5 px-2 text-zinc-100 hover:bg-white/10 sm:col-start-auto">
                <Link to={topologyEdgeEvidenceHref(edge, timeType, bundle.scope)} title="以此拓扑边打开证据包" aria-label={`以拓扑边 ${edge.edgeId} 打开证据包`}>
                  <FileText className="size-3.5" />
                  证据包
                </Link>
              </Button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function AssetsPanel({ agents, workspaces }: { agents: AgentInventoryItem[]; workspaces: WorkspaceInventoryItem[] }) {
  return (
    <Panel title="Agents & Workspaces" icon={<Bot className="size-4 text-emerald-200" />} count={`${agents.length}/${workspaces.length}`}>
      {agents.length === 0 && workspaces.length === 0 ? (
        <EmptyState>暂无资产上下文</EmptyState>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          {agents.map((agent) => (
            <RecordLink
              key={`agent:${agent.workspacePath}:${agent.agentId}`}
              icon={<Bot className="size-4" />}
              title={agent.displayName ?? agent.agentId}
              subtitle={`${agent.agentId} / ${agent.workspacePath}`}
              href={agentHref(agent)}
              tag={agent.healthState}
              tagClassName={statusTone(agent.healthState)}
              meta={agent.owner ?? agent.team ?? formatDate(agent.lastSeen)}
            />
          ))}
          {workspaces.map((workspace) => (
            <RecordLink
              key={`workspace:${workspace.workspacePath}`}
              icon={<GitBranch className="size-4" />}
              title={workspace.workspacePath}
              subtitle={`${workspace.agentCount} agents / ${workspace.collectorCount} collectors`}
              href={workspaceHref(workspace)}
              tag={workspace.healthState}
              tagClassName={statusTone(workspace.healthState)}
              meta={workspace.owner ?? workspace.team ?? formatDate(workspace.lastSeen)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function SourcesCollectorsPanel({ sources, collectors }: { sources: IngestionSourceItem[]; collectors: CollectorHealthItem[] }) {
  return (
    <Panel title="Sources & Collectors" icon={<RadioTower className="size-4 text-sky-200" />} count={`${sources.length}/${collectors.length}`}>
      {sources.length === 0 && collectors.length === 0 ? (
        <EmptyState>暂无接入上下文</EmptyState>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          {sources.map((source) => (
            <RecordLink
              key={`source:${source.sourceId}`}
              icon={<PlugZap className="size-4" />}
              title={source.name}
              subtitle={source.sourceId}
              href={sourceHref(source)}
              tag={source.status}
              tagClassName={statusTone(source.status)}
              meta={formatDate(source.lastSeenAt ?? source.updatedAt)}
            />
          ))}
          {collectors.map((collector) => (
            <RecordLink
              key={`collector:${collector.collectorId}`}
              icon={<RadioTower className="size-4" />}
              title={collector.nodeName ?? collector.collectorId}
              subtitle={collector.collectorId}
              href={collectorHref(collector)}
              tag={collector.stateText}
              tagClassName={statusTone(collector.state)}
              meta={formatDate(collector.lastSeenAt ?? collector.lastHeartbeatAt)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function AuditTrailRow({ audit, timeType }: { audit: AuditListItem; timeType: SecurityTimeType }) {
  const subtitle = `${audit.actor.displayName ?? audit.actor.id} / ${audit.resourceType}:${shortId(audit.resourceId)}`;
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 border-b border-white/8 px-4 py-3 transition hover:bg-white/[0.05] sm:grid-cols-[22px_minmax(0,1fr)_auto_auto]">
      <span className="text-zinc-400"><History className="size-4" /></span>
      <Link to={auditHref(audit)} className="min-w-0 rounded-sm transition hover:text-teal-100">
        <span className="block truncate text-sm font-medium text-zinc-100" title={audit.summary}>{audit.summary}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={subtitle}>{subtitle}</span>
      </Link>
      <span className="flex shrink-0 items-center gap-2">
        <span className="hidden font-mono text-[11px] text-zinc-600 sm:inline">{formatDate(audit.at)}</span>
        <Pill className={statusTone(audit.result)}>{audit.result}</Pill>
      </span>
      <Button asChild variant="secondary" size="sm" className="col-start-2 h-8 w-fit border border-white/10 bg-white/5 px-2 text-zinc-100 hover:bg-white/10 sm:col-start-auto">
        <Link to={auditEvidenceHref(audit, timeType)} title="以此审计记录打开证据包" aria-label={`以审计记录 ${audit.auditId} 打开证据包`}>
          <FileText className="size-3.5" />
          证据包
        </Link>
      </Button>
    </div>
  );
}

function AuditPanel({ audits, timeType }: { audits: AuditListItem[]; timeType: SecurityTimeType }) {
  return (
    <Panel title="Audit Trail" icon={<ScrollText className="size-4 text-amber-200" />} count={audits.length}>
      {audits.length === 0 ? (
        <EmptyState>暂无审计记录</EmptyState>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          {audits.map((audit) => <AuditTrailRow key={audit.auditId} audit={audit} timeType={timeType} />)}
        </div>
      )}
    </Panel>
  );
}

export default function EvidenceBundlePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const [auditId, setAuditId] = useState(searchParams.get("auditId") ?? "");
  const [edgeId, setEdgeId] = useState(searchParams.get("edgeId") ?? "");
  const [eventId, setEventId] = useState(searchParams.get("eventId") ?? "");
  const [incidentId, setIncidentId] = useState(searchParams.get("incidentId") ?? "");
  const [alertId, setAlertId] = useState(searchParams.get("alertId") ?? "");
  const [taskId, setTaskId] = useState(searchParams.get("taskId") ?? "");
  const [objectiveId, setObjectiveId] = useState(searchParams.get("objectiveId") ?? "");
  const [issueId, setIssueId] = useState(searchParams.get("issueId") ?? "");
  const [deliveryId, setDeliveryId] = useState(searchParams.get("deliveryId") ?? "");
  const [windowId, setWindowId] = useState(searchParams.get("windowId") ?? "");
  const [workspacePath, setWorkspacePath] = useState(searchParams.get("workspacePath") ?? "");
  const [agentId, setAgentId] = useState(searchParams.get("agentId") ?? "");
  const [collectorId, setCollectorId] = useState(searchParams.get("collectorId") ?? "");
  const [sourceId, setSourceId] = useState(searchParams.get("sourceId") ?? "");
  const [traceId, setTraceId] = useState(searchParams.get("traceId") ?? "");
  const [runId, setRunId] = useState(searchParams.get("runId") ?? "");
  const [sessionId, setSessionId] = useState(searchParams.get("sessionId") ?? "");
  const [limit, setLimit] = useState(searchParams.get("limit") ?? "180");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  const query = useMemo<EvidenceBundleQuery>(() => {
    const parsedLimit = Number.parseInt(limit, 10);
    return {
      timeType,
      auditId: clean(auditId),
      edgeId: clean(edgeId),
      eventId: clean(eventId),
      incidentId: clean(incidentId),
      alertId: clean(alertId),
      taskId: clean(taskId),
      objectiveId: clean(objectiveId),
      issueId: clean(issueId),
      deliveryId: clean(deliveryId),
      windowId: clean(windowId),
      workspacePath: clean(workspacePath),
      agentId: clean(agentId),
      collectorId: clean(collectorId),
      sourceId: clean(sourceId),
      traceId: clean(traceId),
      runId: clean(runId),
      sessionId: clean(sessionId),
      limit: Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 20), 500) : 180,
    };
  }, [agentId, alertId, auditId, collectorId, deliveryId, edgeId, eventId, incidentId, issueId, limit, objectiveId, runId, sessionId, sourceId, taskId, timeType, traceId, windowId, workspacePath]);

  const { data, loading, error, refresh } = useRequest(() => securityCenterApi.evidenceBundle(query), {
    refreshDeps: [query],
    pollingInterval: 15000,
    pollingWhenHidden: false,
  });

  const applyFilters = () => {
    const next = new URLSearchParams();
    next.set("timeType", timeType);
    Object.entries({
      auditId: clean(auditId),
      edgeId: clean(edgeId),
      eventId: clean(eventId),
      incidentId: clean(incidentId),
      alertId: clean(alertId),
      taskId: clean(taskId),
      objectiveId: clean(objectiveId),
      issueId: clean(issueId),
      deliveryId: clean(deliveryId),
      windowId: clean(windowId),
      workspacePath: clean(workspacePath),
      agentId: clean(agentId),
      collectorId: clean(collectorId),
      sourceId: clean(sourceId),
      traceId: clean(traceId),
      runId: clean(runId),
      sessionId: clean(sessionId),
      limit: clean(limit),
    }).forEach(([key, value]) => {
      if (value) next.set(key, value);
    });
    setSearchParams(next);
  };

  const clearFilters = () => {
    setTimeType("last_3h");
    setAuditId("");
    setEdgeId("");
    setEventId("");
    setIncidentId("");
    setAlertId("");
    setTaskId("");
    setObjectiveId("");
    setIssueId("");
    setDeliveryId("");
    setWindowId("");
    setWorkspacePath("");
    setAgentId("");
    setCollectorId("");
    setSourceId("");
    setTraceId("");
    setRunId("");
    setSessionId("");
    setLimit("180");
    setSearchParams({});
  };

  const downloadJson = () => {
    if (!data) return;
    setExportError("");
    downloadText(`${data.bundleId}.json`, `${JSON.stringify(data, null, 2)}\n`, "application/json; charset=utf-8");
  };

  const downloadMarkdown = async () => {
    setExporting(true);
    setExportError("");
    try {
      const exported = await securityCenterApi.evidenceExport({ ...query, format: "markdown" });
      downloadText(exported.filename, exported.content, exported.contentType);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const errorMessage = error instanceof Error ? error.message : "";

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#0b0f0c] text-zinc-100">
      <header className="shrink-0 border-b border-white/10 bg-[#0b0f0c] px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Button asChild variant="secondary" size="sm" className="h-9 shrink-0 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
              <Link to="/">
                <ArrowLeft className="size-3.5" />
                返回
              </Link>
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <FileText className="size-5 shrink-0 text-teal-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">Evidence Bundle</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">Case File · Timeline · Topology · Audit</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <Clock3 className="size-3.5" />
            <span>{data?.generatedAt ? formatDate(data.generatedAt) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2 2xl:grid-cols-[120px_minmax(130px,1fr)_minmax(130px,1fr)_minmax(130px,1fr)_minmax(130px,1fr)_minmax(130px,1fr)_minmax(130px,1fr)_minmax(130px,1fr)_minmax(130px,1fr)_minmax(130px,1fr)_minmax(130px,1fr)_minmax(160px,1.2fr)_minmax(130px,1fr)_minmax(130px,1fr)_minmax(130px,1fr)_minmax(160px,1fr)_minmax(130px,1fr)_minmax(130px,1fr)_88px_auto_auto_auto_auto_auto]">
          <Select value={timeType} onValueChange={(next) => setTimeType(next as SecurityTimeType)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={auditId} onChange={(event) => setAuditId(event.target.value)} placeholder="auditId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={edgeId} onChange={(event) => setEdgeId(event.target.value)} placeholder="edgeId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={eventId} onChange={(event) => setEventId(event.target.value)} placeholder="eventId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={incidentId} onChange={(event) => setIncidentId(event.target.value)} placeholder="incidentId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={alertId} onChange={(event) => setAlertId(event.target.value)} placeholder="alertId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={taskId} onChange={(event) => setTaskId(event.target.value)} placeholder="taskId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={objectiveId} onChange={(event) => setObjectiveId(event.target.value)} placeholder="objectiveId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={issueId} onChange={(event) => setIssueId(event.target.value)} placeholder="issueId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={deliveryId} onChange={(event) => setDeliveryId(event.target.value)} placeholder="deliveryId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={windowId} onChange={(event) => setWindowId(event.target.value)} placeholder="windowId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="workspacePath" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="agentId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={collectorId} onChange={(event) => setCollectorId(event.target.value)} placeholder="collectorId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="sourceId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={traceId} onChange={(event) => setTraceId(event.target.value)} placeholder="traceId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="runId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="sessionId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={limit} onChange={(event) => setLimit(event.target.value.replace(/\D/g, "").slice(0, 3))} placeholder="limit" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Button type="button" variant="secondary" size="sm" onClick={applyFilters} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Search className="size-3.5" />
            应用
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={clearFilters} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <X className="size-3.5" />
            清除
          </Button>
          <Button type="button" size="sm" onClick={refresh} disabled={loading} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={downloadJson} disabled={!data} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Download className="size-3.5" />
            JSON
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={downloadMarkdown} disabled={exporting} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            {exporting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            Markdown
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-4">
          {exportError ? (
            <section className="rounded-[8px] border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{exportError}</section>
          ) : null}
          {loading && !data ? (
            <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-48 items-center justify-center text-sm text-zinc-500">
                <LoaderCircle className="mr-2 size-4 animate-spin" />
                加载 Evidence Bundle...
              </div>
            </section>
          ) : errorMessage ? (
            <section className="rounded-[8px] border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{errorMessage}</section>
          ) : data ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-12">
                <MetricTile label="Events" value={data.summary.eventCount} tone="border-teal-400/25 bg-teal-500/10 text-teal-100" />
                <MetricTile label="Incidents" value={data.summary.incidentCount} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
                <MetricTile label="Alerts" value={data.summary.alertCount} tone="border-sky-400/25 bg-sky-500/10 text-sky-100" />
                <MetricTile label="Remediation" value={data.summary.remediationCount} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
                <MetricTile label="Objectives" value={data.summary.objectiveCount} tone="border-orange-400/25 bg-orange-500/10 text-orange-100" />
                <MetricTile label="Notify" value={data.summary.notificationDeliveryCount} tone="border-fuchsia-400/25 bg-fuchsia-500/10 text-fuchsia-100" />
                <MetricTile label="Maint" value={data.summary.maintenanceWindowCount} tone="border-indigo-400/25 bg-indigo-500/10 text-indigo-100" />
                <MetricTile label="Assets" value={`${data.summary.agentCount}/${data.summary.workspaceCount}`} tone="border-emerald-400/25 bg-emerald-500/10 text-emerald-100" />
                <MetricTile label="Coverage" value={data.summary.coverageIssueCount} tone="border-violet-400/25 bg-violet-500/10 text-violet-100" />
                <MetricTile label="Topology" value={`${data.summary.topologyNodeCount}/${data.summary.topologyEdgeCount}`} tone="border-cyan-400/25 bg-cyan-500/10 text-cyan-100" />
                <MetricTile label="Audit" value={data.summary.auditCount} tone="border-lime-400/25 bg-lime-500/10 text-lime-100" />
                <MetricTile label="Max" value={data.summary.maxSeverity ? SEVERITY_LABEL[data.summary.maxSeverity] : "--"} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
              </div>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.18fr)_minmax(400px,0.82fr)]">
                <div className="space-y-4">
                  <PrimaryPanel bundle={data} />
                  <TimelinePanel bundle={data} />
                  <EventsPanel events={data.events} />
                  <div className="grid gap-4 2xl:grid-cols-3">
                    <IncidentsPanel incidents={data.incidents} />
                    <AlertsPanel alerts={data.alerts} />
                    <RemediationsPanel remediations={data.remediations} />
                  </div>
                </div>

                <div className="space-y-4">
                  <ScopePanel bundle={data} />
                  <RiskPanel bundle={data} />
                  <ObjectivesPanel objectives={data.objectives} />
                  <NotificationDeliveriesPanel deliveries={data.notificationDeliveries} timeType={timeType} />
                  <MaintenanceWindowsPanel windows={data.maintenanceWindows} timeType={timeType} />
                  <CoveragePanel issues={data.coverageIssues} />
                  <TopologyPanel bundle={data} timeType={timeType} />
                  <AssetsPanel agents={data.agents} workspaces={data.workspaces} />
                  <SourcesCollectorsPanel sources={data.sources} collectors={data.collectors} />
                  <AuditPanel audits={data.audits} timeType={timeType} />
                </div>
              </div>
            </>
          ) : (
            <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
              <EmptyState>暂无 Evidence Bundle</EmptyState>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
