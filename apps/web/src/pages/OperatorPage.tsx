import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  AlertTriangle,
  ArrowLeft,
  BellRing,
  Bot,
  CheckCircle2,
  Clock3,
  Copy,
  EyeOff,
  FileCheck2,
  FileText,
  LoaderCircle,
  PlugZap,
  RadioTower,
  RefreshCw,
  Search,
  ShieldAlert,
  Siren,
  Target,
  Terminal,
  UserCheck,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { generatedSecurityCapabilityCurl } from "@/lib/api/security-capability-curl";
import {
  type EvidenceBundle,
  type EvidenceBundleQuery,
  type RemediationActionKind,
  type RemediationSourceType,
  type RemediationStatus,
  type SecurityCapabilityRequest,
  type SecurityCapabilityResponse,
  type SecurityNextActionPlan,
  type SecurityNextActionPlanItem,
  type SecurityNextActionPlanParams,
  type SecuritySeverity,
  type SecurityTimeType,
  securityCenterApi,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";

const TIME_OPTIONS: Array<{ value: SecurityTimeType; label: string }> = [
  { value: "last_3h", label: "近3小时" },
  { value: "last_1d", label: "近一天" },
  { value: "last_7d", label: "近一周" },
  { value: "last_30d", label: "近一月" },
];

const LIMIT_OPTIONS = [
  { value: "5", label: "Top 5" },
  { value: "10", label: "Top 10" },
  { value: "15", label: "Top 15" },
  { value: "20", label: "Top 20" },
];

const STATUS_OPTIONS: Array<{ value: RemediationStatus | "all"; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "open", label: "待处理" },
  { value: "in_progress", label: "处理中" },
  { value: "blocked", label: "阻塞" },
  { value: "done", label: "完成" },
  { value: "dismissed", label: "忽略" },
];

const SOURCE_OPTIONS: Array<{ value: RemediationSourceType | "all"; label: string }> = [
  { value: "all", label: "全部来源" },
  { value: "incident", label: "Incident" },
  { value: "alert", label: "Alert" },
  { value: "coverage", label: "Coverage" },
];

const SEVERITY_OPTIONS: Array<{ value: SecuritySeverity | "all"; label: string }> = [
  { value: "all", label: "全部等级" },
  { value: "critical", label: "严重" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
  { value: "info", label: "提示" },
];

const STATUS_LABEL: Record<RemediationStatus, string> = {
  open: "待处理",
  in_progress: "处理中",
  blocked: "阻塞",
  done: "完成",
  dismissed: "忽略",
};

const SOURCE_LABEL: Record<RemediationSourceType, string> = {
  incident: "Incident",
  alert: "Alert",
  coverage: "Coverage",
};

const SEVERITY_LABEL: Record<SecuritySeverity, string> = {
  info: "提示",
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
};

const ACTION_LABEL: Record<RemediationActionKind, string> = {
  investigate: "调查",
  collector: "采集链路",
  source: "接入源",
  policy: "策略",
  credential: "凭据",
  network: "网络",
  file: "文件",
  ownership: "归属",
};

function clean(value: string) {
  return value.trim() || undefined;
}

function formatDate(value?: string) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asPlan(value: unknown): SecurityNextActionPlan | undefined {
  const item = objectValue(value);
  if (!item) return undefined;
  if (item.schemaVersion === "anysentry.progressive.next_action_plan.v1") return item as unknown as SecurityNextActionPlan;
  const data = item.data;
  if (
    data &&
    typeof data === "object" &&
    "schemaVersion" in data &&
    data.schemaVersion === "anysentry.progressive.next_action_plan.v1"
  ) {
    return data as SecurityNextActionPlan;
  }
  return undefined;
}

function asBundle(value: unknown): EvidenceBundle | undefined {
  const item = objectValue(value);
  if (!item) return undefined;
  if (item.schemaVersion === "anysentry.evidence_bundle.v1") return item as unknown as EvidenceBundle;
  const data = item.data;
  if (
    data &&
    typeof data === "object" &&
    "schemaVersion" in data &&
    data.schemaVersion === "anysentry.evidence_bundle.v1"
  ) {
    return data as EvidenceBundle;
  }
  return undefined;
}

function queryString(params: Record<string, string | number | boolean | undefined>) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const text = String(value ?? "").trim();
    if (text) qs.set(key, text);
  }
  return qs.toString();
}

function evidenceBundleParams(hint: EvidenceBundleQuery, action: SecurityNextActionPlanItem, timeType: SecurityTimeType): EvidenceBundleQuery {
  return {
    ...hint,
    timeType,
    taskId: hint.taskId ?? action.taskId,
    eventId: hint.eventId ?? action.eventId,
    traceId: hint.traceId ?? action.traceId,
    objectiveId: hint.objectiveId ?? action.objectiveId,
    issueId: hint.issueId ?? action.issueId,
    agentId: hint.agentId ?? action.agentId,
    workspacePath: hint.workspacePath ?? action.workspacePath,
    collectorId: hint.collectorId ?? action.collectorId,
    sourceId: hint.sourceId ?? action.sourceIdentity,
    limit: hint.limit ?? 40,
  };
}

function evidenceQuery(hint: EvidenceBundleQuery, action: SecurityNextActionPlanItem, timeType: SecurityTimeType) {
  return queryString(evidenceBundleParams(hint, action, timeType) as Record<string, string | number | boolean | undefined>);
}

function remediationQuery(action: SecurityNextActionPlanItem, timeType: SecurityTimeType) {
  return queryString({
    timeType,
    taskId: action.taskId,
    sourceType: action.sourceType,
    issueId: action.issueId,
    objectiveId: action.objectiveId,
    eventId: action.eventId,
    agentId: action.agentId,
    workspacePath: action.workspacePath,
    collectorId: action.collectorId,
    sourceId: action.sourceIdentity,
  });
}

function operatorRouteParams({
  timeType,
  status,
  sourceType,
  severity,
  queryText,
  workspacePath,
  agentId,
  owner,
  maxActions,
  selectedActionId,
  selectedAction,
}: {
  timeType: SecurityTimeType;
  status: RemediationStatus | "all";
  sourceType: RemediationSourceType | "all";
  severity: SecuritySeverity | "all";
  queryText: string;
  workspacePath: string;
  agentId: string;
  owner: string;
  maxActions: string;
  selectedActionId?: string;
  selectedAction?: SecurityNextActionPlanItem;
}) {
  const next = new URLSearchParams();
  if (timeType !== "last_3h" || selectedActionId) next.set("timeType", timeType);
  if (maxActions !== "10" || selectedActionId) next.set("maxActions", maxActions);
  if (status !== "all") next.set("status", status);
  if (selectedAction) next.set("sourceType", selectedAction.sourceType);
  else if (sourceType !== "all") next.set("sourceType", sourceType);
  if (severity !== "all") next.set("severity", severity);
  if (clean(queryText)) next.set("q", queryText.trim());
  if (selectedActionId) next.set("actionId", selectedActionId);
  if (selectedAction?.taskId) next.set("taskId", selectedAction.taskId);
  if (selectedAction?.agentId) next.set("agentId", selectedAction.agentId);
  else if (clean(agentId)) next.set("agentId", agentId.trim());
  if (selectedAction?.workspacePath) next.set("workspacePath", selectedAction.workspacePath);
  else if (clean(workspacePath)) next.set("workspacePath", workspacePath.trim());
  if (selectedAction?.sourceIdentity) next.set("sourceId", selectedAction.sourceIdentity);
  if (clean(owner)) next.set("owner", owner.trim());
  if (selectedAction?.objectiveId) next.set("objectiveId", selectedAction.objectiveId);
  if (selectedAction?.issueId) next.set("issueId", selectedAction.issueId);
  return next;
}

function toneBySeverity(severity?: SecuritySeverity) {
  if (severity === "critical" || severity === "high") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (severity === "medium") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (severity === "low") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function toneByStatus(status?: RemediationStatus) {
  if (status === "open") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (status === "in_progress") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (status === "blocked") return "border-orange-400/30 bg-orange-500/10 text-orange-100";
  if (status === "done") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function toneBySource(source?: RemediationSourceType) {
  if (source === "incident") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (source === "alert") return "border-sky-400/30 bg-sky-500/10 text-sky-100";
  return "border-amber-400/30 bg-amber-500/10 text-amber-100";
}

function Pill({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", className)}>
      {children}
    </span>
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

function FieldValue({ label, value }: { label: string; value?: string | number | boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-zinc-600">{label}</p>
      <p className="mt-1 truncate font-mono text-xs text-zinc-300" title={String(value ?? "")}>
        {value ?? "--"}
      </p>
    </div>
  );
}

function ActionRow({
  action,
  active,
  onSelect,
}: {
  action: SecurityNextActionPlanItem;
  active: boolean;
  onSelect: () => void;
}) {
  const pendingSteps = action.nextSteps.filter((step) => !step.done).length;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[48px_minmax(0,1fr)_78px_76px_70px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8",
      )}
    >
      <span className="font-mono text-xs font-semibold text-teal-200">#{action.rank}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={action.title}>
          {action.title}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-zinc-600" title={action.recommendedAction}>
          {action.agentId ?? action.sourceIdentity ?? action.collectorId ?? action.workspacePath ?? ACTION_LABEL[action.actionKind]} · {pendingSteps} steps
        </span>
      </span>
      <span><Pill className={toneBySource(action.sourceType)}>{SOURCE_LABEL[action.sourceType]}</Pill></span>
      <span><Pill className={toneBySeverity(action.severity)}>{SEVERITY_LABEL[action.severity]}</Pill></span>
      <span><Pill className={toneByStatus(action.status)}>{STATUS_LABEL[action.status]}</Pill></span>
    </button>
  );
}

function ActionLinks({ action, timeType }: { action: SecurityNextActionPlanItem; timeType: SecurityTimeType }) {
  const evidenceHref = `/evidence?${evidenceQuery(action.evidence.bundleHint, action, timeType)}`;
  const remediationHref = `/remediation?${remediationQuery(action, timeType)}`;
  const eventHref = action.eventId
    ? `/events?${queryString({
        timeType,
        eventId: action.eventId,
        traceId: action.traceId,
        agentId: action.agentId,
        workspacePath: action.workspacePath,
        collectorId: action.collectorId,
        sourceId: action.sourceIdentity,
      })}`
    : undefined;
  const incidentHref = action.evidence.incidentId
    ? `/incidents?${queryString({
        incidentId: action.evidence.incidentId,
        traceId: action.traceId,
        agentId: action.agentId,
        workspacePath: action.workspacePath,
        collectorId: action.collectorId,
        sourceId: action.sourceIdentity,
      })}`
    : undefined;
  const alertHref = action.evidence.alertId
    ? `/alerts?${queryString({
        alertId: action.evidence.alertId,
        issueId: action.issueId,
        agentId: action.agentId,
        workspacePath: action.workspacePath,
        collectorId: action.collectorId,
        sourceId: action.sourceIdentity,
      })}`
    : undefined;
  const coverageHref = action.issueId
    ? `/coverage?${queryString({
        issueId: action.issueId,
        agentId: action.agentId,
        workspacePath: action.workspacePath,
        collectorId: action.collectorId,
        sourceId: action.sourceIdentity,
      })}`
    : undefined;
  const objectiveHref = action.objectiveId ? `/objectives?${queryString({ objectiveId: action.objectiveId, sourceId: action.sourceIdentity })}` : undefined;
  const agentHref = action.agentId ? `/agents?${queryString({ agentId: action.agentId, workspacePath: action.workspacePath })}` : undefined;
  const collectorHref = action.collectorId ? `/collectors?${queryString({ collectorId: action.collectorId })}` : undefined;
  const sourceHref = action.sourceIdentity
    ? `/sources?${queryString({ sourceId: action.sourceIdentity, collectorId: action.collectorId, workspacePath: action.workspacePath })}`
    : undefined;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
        <Link to={evidenceHref}>
          <FileText className="size-3.5" />
          证据包
        </Link>
      </Button>
      <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
        <Link to={remediationHref}>
          <FileCheck2 className="size-3.5" />
          处置
        </Link>
      </Button>
      {eventHref ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={eventHref}>
            <Search className="size-3.5" />
            事件
          </Link>
        </Button>
      ) : null}
      {incidentHref ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={incidentHref}>
            <Siren className="size-3.5" />
            Incident
          </Link>
        </Button>
      ) : null}
      {alertHref ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={alertHref}>
            <BellRing className="size-3.5" />
            Alert
          </Link>
        </Button>
      ) : null}
      {coverageHref ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={coverageHref}>
            <EyeOff className="size-3.5" />
            Coverage
          </Link>
        </Button>
      ) : null}
      {objectiveHref ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={objectiveHref}>
            <Target className="size-3.5" />
            目标
          </Link>
        </Button>
      ) : null}
      {agentHref ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={agentHref}>
            <Bot className="size-3.5" />
            Agent
          </Link>
        </Button>
      ) : null}
      {collectorHref ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={collectorHref}>
            <RadioTower className="size-3.5" />
            Collector
          </Link>
        </Button>
      ) : null}
      {sourceHref ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={sourceHref}>
            <PlugZap className="size-3.5" />
            Source
          </Link>
        </Button>
      ) : null}
    </div>
  );
}

function EvidencePreview({
  bundle,
  loading,
  error,
}: {
  bundle?: EvidenceBundle;
  loading: boolean;
  error?: string;
}) {
  if (loading) {
    return (
      <div className="flex min-h-24 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-xs text-zinc-500">
        <LoaderCircle className="mr-2 size-4 animate-spin" />
        加载证据包...
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
        {error}
      </div>
    );
  }
  if (!bundle) {
    return (
      <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-500">
        点击预览证据加载当前行动的治理证据。
      </div>
    );
  }
  const riskNames = bundle.summary.riskCategories.map((item) => item.riskName).slice(0, 3);
  const recentEvents = bundle.events.slice(0, 3);
  return (
    <div className="space-y-3 rounded-md border border-white/10 bg-white/[0.03] p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <FieldValue label="Bundle" value={bundle.bundleId} />
        <FieldValue label="Primary" value={`${bundle.scope.primaryType}:${bundle.scope.primaryId ?? "--"}`} />
        <FieldValue label="Generated" value={formatDate(bundle.generatedAt)} />
        <FieldValue label="Events" value={bundle.summary.eventCount} />
        <FieldValue label="Alerts" value={bundle.summary.alertCount} />
        <FieldValue label="Remediations" value={bundle.summary.remediationCount} />
        <FieldValue label="Incidents" value={bundle.summary.incidentCount} />
        <FieldValue label="Coverage" value={bundle.summary.coverageIssueCount} />
        <FieldValue label="Max Severity" value={bundle.summary.maxSeverity ? SEVERITY_LABEL[bundle.summary.maxSeverity] : "--"} />
      </div>
      {riskNames.length ? (
        <div className="flex flex-wrap gap-2">
          {riskNames.map((riskName) => (
            <Pill key={riskName} className="border-amber-400/25 bg-amber-500/10 text-amber-100">{riskName}</Pill>
          ))}
        </div>
      ) : null}
      {recentEvents.length ? (
        <div className="space-y-2">
          {recentEvents.map((event) => (
            <div key={event.eventId} className="grid grid-cols-[86px_minmax(0,1fr)_72px] items-center gap-2 rounded-md border border-white/10 bg-[#111612]/70 px-3 py-2">
              <span className="font-mono text-[11px] text-zinc-500">{formatDate(event.at)}</span>
              <span className="truncate text-xs text-zinc-200" title={event.subject}>{event.subject}</span>
              <Pill className={toneBySeverity(event.severity)}>{SEVERITY_LABEL[event.severity]}</Pill>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActionDetail({
  action,
  timeType,
  evidence,
  evidenceLoading,
  evidenceError,
  savingStatus,
  onLoadEvidence,
  onUpdateStatus,
}: {
  action?: SecurityNextActionPlanItem;
  timeType: SecurityTimeType;
  evidence?: EvidenceBundle;
  evidenceLoading: boolean;
  evidenceError?: string;
  savingStatus: boolean;
  onLoadEvidence: (action: SecurityNextActionPlanItem) => void;
  onUpdateStatus: (action: SecurityNextActionPlanItem, status: RemediationStatus) => void;
}) {
  if (!action) {
    return (
      <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
        <div className="flex min-h-[360px] items-center justify-center text-sm text-zinc-500">等待下一步行动</div>
      </section>
    );
  }

  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Zap className="size-4 shrink-0 text-teal-200" />
          <h2 className="truncate text-sm font-semibold text-zinc-100">{action.title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action.needsApproval ? <Pill className="border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-100">需审批</Pill> : null}
          {action.overdue ? <Pill className="border-rose-400/30 bg-rose-500/10 text-rose-100">逾期</Pill> : null}
          <Pill className={toneBySeverity(action.severity)}>{SEVERITY_LABEL[action.severity]}</Pill>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FieldValue label="Action ID" value={action.actionId} />
          <FieldValue label="Task ID" value={action.taskId} />
          <FieldValue label="Primary" value={`${action.evidence.primaryType}:${action.evidence.primaryId}`} />
          <FieldValue label="Action" value={ACTION_LABEL[action.actionKind]} />
          <FieldValue label="Status" value={STATUS_LABEL[action.status]} />
          <FieldValue label="Owner" value={action.owner} />
          <FieldValue label="Due" value={formatDate(action.dueAt)} />
          <FieldValue label="Agent" value={action.agentId} />
          <FieldValue label="Workspace" value={action.workspacePath} />
          <FieldValue label="Collector" value={action.collectorId} />
          <FieldValue label="Source" value={action.sourceIdentity} />
          <FieldValue label="Trace" value={action.traceId} />
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">建议动作</p>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">{action.recommendedAction}</div>
        </div>

        <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-zinc-100">Next Steps</h3>
            <span className="text-[11px] text-zinc-500">{action.nextSteps.length}</span>
          </div>
          {action.nextSteps.length === 0 ? (
            <div className="rounded-md border border-white/10 bg-[#111612]/70 px-3 py-2 text-xs text-zinc-500">无待执行步骤</div>
          ) : (
            <div className="space-y-2">
              {action.nextSteps.map((step) => (
                <div
                  key={step.stepId}
                  className={cn(
                    "grid grid-cols-[20px_minmax(0,1fr)] gap-2 rounded-md border px-3 py-2",
                    step.done ? "border-teal-400/25 bg-teal-500/10" : "border-white/10 bg-[#111612]/70",
                  )}
                >
                  <span className={cn("mt-0.5 inline-flex size-4 items-center justify-center rounded-full border", step.done ? "border-teal-300 bg-teal-400 text-[#07100c]" : "border-white/20 text-zinc-500")}>
                    {step.done ? <CheckCircle2 className="size-3" /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className={cn("block truncate text-xs font-medium", step.done ? "text-teal-100" : "text-zinc-100")} title={step.title}>{step.title}</span>
                    {step.detail ? <span className="mt-0.5 block truncate text-[11px] text-zinc-500" title={step.detail}>{step.detail}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FieldValue label="Event" value={action.eventId} />
          <FieldValue label="Incident" value={action.evidence.incidentId} />
          <FieldValue label="Alert" value={action.evidence.alertId} />
          <FieldValue label="Objective" value={action.objectiveId} />
          <FieldValue label="Coverage Issue" value={action.issueId} />
          <FieldValue label="Bundle Hint" value={Object.keys(action.evidence.bundleHint).join(", ")} />
        </div>

        <ActionLinks action={action} timeType={timeType} />

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={evidenceLoading} onClick={() => onLoadEvidence(action)} className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            {evidenceLoading ? <LoaderCircle className="size-3.5 animate-spin" /> : <FileText className="size-3.5" />}
            预览证据
          </Button>
          <Button type="button" size="sm" disabled={savingStatus || action.status === "in_progress"} onClick={() => onUpdateStatus(action, "in_progress")} className="h-8 bg-amber-400 text-[#171004] hover:bg-amber-300">
            {savingStatus ? <LoaderCircle className="size-3.5 animate-spin" /> : <UserCheck className="size-3.5" />}
            处理中
          </Button>
          <Button type="button" size="sm" disabled={savingStatus || action.status === "done"} onClick={() => onUpdateStatus(action, "done")} className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            <CheckCircle2 className="size-3.5" />
            完成
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={savingStatus || action.status === "blocked"} onClick={() => onUpdateStatus(action, "blocked")} className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <AlertTriangle className="size-3.5" />
            阻塞
          </Button>
        </div>

        <EvidencePreview bundle={evidence} loading={evidenceLoading} error={evidenceError} />
      </div>
    </section>
  );
}

export default function OperatorPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const [status, setStatus] = useState<RemediationStatus | "all">((searchParams.get("status") as RemediationStatus) || "all");
  const [sourceType, setSourceType] = useState<RemediationSourceType | "all">((searchParams.get("sourceType") as RemediationSourceType) || "all");
  const [severity, setSeverity] = useState<SecuritySeverity | "all">((searchParams.get("severity") as SecuritySeverity) || "all");
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const [workspacePath, setWorkspacePath] = useState(searchParams.get("workspacePath") ?? "");
  const [agentId, setAgentId] = useState(searchParams.get("agentId") ?? "");
  const [owner, setOwner] = useState(searchParams.get("owner") ?? "");
  const [maxActions, setMaxActions] = useState(searchParams.get("maxActions") ?? "10");
  const [selectedActionId, setSelectedActionId] = useState(searchParams.get("actionId") ?? "");
  const [evidenceActionId, setEvidenceActionId] = useState("");
  const [evidence, setEvidence] = useState<EvidenceBundle>();
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState("");
  const [savingStatus, setSavingStatus] = useState(false);
  const [copiedPlanCurl, setCopiedPlanCurl] = useState(false);

  const params = useMemo<SecurityNextActionPlanParams>(() => ({
    timeType,
    status,
    sourceType,
    severity,
    q: clean(queryText),
    workspacePath: clean(workspacePath),
    agentId: clean(agentId),
    owner: clean(owner),
    maxActions: Number(maxActions),
  }), [agentId, maxActions, owner, queryText, severity, sourceType, status, timeType, workspacePath]);

  const { data: rawData, loading, refresh } = useRequest(() => securityCenterApi.nextActionPlan(params), {
    refreshDeps: [params],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });
  const data = asPlan(rawData);
  const planRequest = useMemo<SecurityCapabilityRequest>(() => ({
    action: "execute",
    module: "security-center",
    operation: "planNextActions",
    params,
  }), [params]);
  const planCurl = useMemo(() => generatedSecurityCapabilityCurl(planRequest), [planRequest]);

  const selectedAction = useMemo(() => {
    const actions = data?.actions ?? [];
    return actions.find((item) => item.actionId === selectedActionId) ?? actions[0];
  }, [data, selectedActionId]);
  const selectedEvidence = selectedAction?.actionId === evidenceActionId ? evidence : undefined;
  const selectedEvidenceError = selectedAction?.actionId === evidenceActionId ? evidenceError : "";
  const routeText = searchParams.toString();

  useEffect(() => {
    const next = operatorRouteParams({
      timeType,
      status,
      sourceType,
      severity,
      queryText,
      workspacePath,
      agentId,
      owner,
      maxActions,
      selectedActionId,
      selectedAction: selectedActionId ? selectedAction : undefined,
    });
    if (next.toString() !== routeText) setSearchParams(next, { replace: true });
  }, [agentId, maxActions, owner, queryText, routeText, selectedAction, selectedActionId, setSearchParams, severity, sourceType, status, timeType, workspacePath]);

  const selectAction = (action: SecurityNextActionPlanItem) => {
    setSelectedActionId(action.actionId);
    setSearchParams(operatorRouteParams({
      timeType,
      status,
      sourceType,
      severity,
      queryText,
      workspacePath,
      agentId,
      owner,
      maxActions,
      selectedActionId: action.actionId,
      selectedAction: action,
    }));
  };

  const clearFilters = () => {
    setStatus("all");
    setSourceType("all");
    setSeverity("all");
    setQueryText("");
    setWorkspacePath("");
    setAgentId("");
    setOwner("");
    setMaxActions("10");
    setSelectedActionId("");
    setEvidenceActionId("");
    setEvidence(undefined);
    setEvidenceError("");
    setSearchParams({});
  };

  const loadEvidence = async (action: SecurityNextActionPlanItem) => {
    setEvidenceActionId(action.actionId);
    setEvidence(undefined);
    setEvidenceError("");
    setEvidenceLoading(true);
    try {
      const response = await securityCenterApi.evidenceBundleCapability(evidenceBundleParams(action.evidence.bundleHint, action, timeType));
      const bundle = asBundle(response);
      if (!bundle) throw new Error("证据包响应格式不匹配");
      setEvidence(bundle);
    } catch (error) {
      setEvidenceError(error instanceof Error ? error.message : "证据包加载失败");
    } finally {
      setEvidenceLoading(false);
    }
  };

  const updateActionStatus = async (action: SecurityNextActionPlanItem, nextStatus: RemediationStatus) => {
    setSavingStatus(true);
    try {
      await securityCenterApi.updateRemediation(action.taskId, { status: nextStatus });
      setSelectedActionId(action.actionId);
      await refresh();
    } finally {
      setSavingStatus(false);
    }
  };

  const copyPlanCurl = async () => {
    await navigator.clipboard?.writeText(planCurl);
    setCopiedPlanCurl(true);
    window.setTimeout(() => setCopiedPlanCurl(false), 1600);
  };

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
                <Zap className="size-5 shrink-0 text-teal-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">AI Operator</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">Progressive API · planNextActions</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <Clock3 className="size-3.5" />
            <span>{data?.generatedAt ? formatDate(data.generatedAt) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 xl:grid-cols-[120px_130px_130px_130px_minmax(150px,1fr)_minmax(150px,1fr)_minmax(130px,0.8fr)_100px_auto_auto]">
          <Select value={timeType} onValueChange={(next) => setTimeType(next as SecurityTimeType)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={status} onValueChange={(next) => setStatus(next as RemediationStatus | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{STATUS_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={sourceType} onValueChange={(next) => setSourceType(next as RemediationSourceType | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{SOURCE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={severity} onValueChange={(next) => setSeverity(next as SecuritySeverity | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{SEVERITY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="workspacePath" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="agentId" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="owner / team" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Select value={maxActions} onValueChange={setMaxActions}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{LIMIT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button type="button" variant="secondary" size="sm" onClick={clearFilters} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <X className="size-3.5" />
            清除
          </Button>
          <Button type="button" size="sm" onClick={refresh} disabled={loading} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
        </div>

        <div className="mt-2 grid gap-2 md:grid-cols-[minmax(180px,1fr)_auto]">
          <Input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="search task / source / evidence" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Button asChild variant="secondary" size="sm" className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Link to="/remediation">
              <FileCheck2 className="size-3.5" />
              处置中心
            </Link>
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <MetricTile label="候选任务" value={data?.summary.totalCandidates ?? 0} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
            <MetricTile label="返回行动" value={data?.summary.returnedActions ?? 0} tone="border-sky-400/25 bg-sky-500/10 text-sky-100" />
            <MetricTile label="严重行动" value={data?.summary.criticalActions ?? 0} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
            <MetricTile label="逾期行动" value={data?.summary.overdueActions ?? 0} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
            <MetricTile label="需审批" value={data?.summary.approvalRequiredActions ?? 0} tone="border-fuchsia-400/25 bg-fuchsia-500/10 text-fuchsia-100" />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(620px,1fr)_minmax(0,1.05fr)]">
            <section className="min-h-[620px] rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <UserCheck className="size-4 text-teal-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">Next Actions</h2>
                </div>
                <span className="text-xs text-zinc-500">{data ? `${data.actions.length} / ${data.summary.totalCandidates}` : "--"}</span>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  加载行动计划...
                </div>
              ) : (data?.actions.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">暂无下一步行动</div>
              ) : (
                <div className="max-h-[calc(100vh-350px)] overflow-y-auto">
                  {data?.actions.map((action) => (
                    <ActionRow
                      key={action.actionId}
                      action={action}
                      active={action.actionId === selectedAction?.actionId}
                      onSelect={() => selectAction(action)}
                    />
                  ))}
                </div>
              )}
            </section>

            <div className="space-y-4">
              <ActionDetail
                action={selectedAction}
                timeType={timeType}
                evidence={selectedEvidence}
                evidenceLoading={evidenceLoading && selectedAction?.actionId === evidenceActionId}
                evidenceError={selectedEvidenceError}
                savingStatus={savingStatus}
                onLoadEvidence={loadEvidence}
                onUpdateStatus={updateActionStatus}
              />
              <section className="rounded-[8px] border border-white/10 bg-[#111612]/92 p-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <FieldValue label="Schema" value={data?.schemaVersion} />
                  <FieldValue label="Module" value={data?.module} />
                  <FieldValue label="Operation" value={data?.operation} />
                  <FieldValue label="Scope Workspace" value={data?.scope.workspacePath} />
                  <FieldValue label="Scope Agent" value={data?.scope.agentId} />
                  <FieldValue label="Scope Owner" value={data?.scope.owner} />
                </div>
              </section>
              <section className="rounded-[8px] border border-white/10 bg-[#111612]/92 p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-zinc-400">
                    <Terminal className="size-3.5 shrink-0 text-teal-200" />
                    <span className="truncate">Canonical planNextActions curl</span>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    onClick={copyPlanCurl}
                    title={copiedPlanCurl ? "Copied planNextActions curl" : "Copy planNextActions curl"}
                    aria-label={copiedPlanCurl ? "Copied planNextActions curl" : "Copy planNextActions curl"}
                    className="shrink-0 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
                  >
                    {copiedPlanCurl ? <CheckCircle2 className="size-3.5 text-teal-200" /> : <Copy className="size-3.5" />}
                  </Button>
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-white/10 bg-[#080c09] p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                  {planCurl}
                </pre>
              </section>
              {selectedAction?.needsApproval ? (
                <section className="rounded-[8px] border border-fuchsia-400/25 bg-fuchsia-500/10 p-4 text-xs text-fuchsia-100">
                  <div className="flex items-center gap-2 font-semibold">
                    <ShieldAlert className="size-4" />
                    Approval Gate
                  </div>
                  <p className="mt-2 text-fuchsia-100/80">
                    严重级别、凭据、策略、网络或阻塞高风险任务需要人工确认后再执行。
                  </p>
                </section>
              ) : selectedAction ? (
                <section className="rounded-[8px] border border-teal-400/25 bg-teal-500/10 p-4 text-xs text-teal-100">
                  <div className="flex items-center gap-2 font-semibold">
                    <CheckCircle2 className="size-4" />
                    Ready
                  </div>
                  <p className="mt-2 text-teal-100/80">该行动可进入处置中心继续推进。</p>
                </section>
              ) : null}
              {selectedAction?.overdue ? (
                <section className="rounded-[8px] border border-rose-400/25 bg-rose-500/10 p-4 text-xs text-rose-100">
                  <div className="flex items-center gap-2 font-semibold">
                    <AlertTriangle className="size-4" />
                    Overdue
                  </div>
                  <p className="mt-2 text-rose-100/80">截止时间已过，建议优先处理或重新排期。</p>
                </section>
              ) : null}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
