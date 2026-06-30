import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  ArrowLeft,
  BellRing,
  Bot,
  CheckCircle2,
  Clock3,
  FileText,
  FileCheck2,
  LoaderCircle,
  PlugZap,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Siren,
  Target,
  TerminalSquare,
  UserCheck,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type AlertKind,
  type AlertListItem,
  type AlertListQuery,
  type AlertStatus,
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

const STATUS_OPTIONS: Array<{ value: AlertStatus | "all"; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "open", label: "待处理" },
  { value: "acknowledged", label: "已确认" },
  { value: "silenced", label: "已静默" },
  { value: "resolved", label: "已解决" },
];

const SEVERITY_OPTIONS: Array<{ value: SecuritySeverity | "all"; label: string }> = [
  { value: "all", label: "全部等级" },
  { value: "critical", label: "严重" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
  { value: "info", label: "提示" },
];

const KIND_OPTIONS: Array<{ value: AlertKind | "all"; label: string }> = [
  { value: "all", label: "全部来源" },
  { value: "incident", label: "Incident" },
  { value: "collector", label: "Collector" },
  { value: "agent", label: "Agent" },
  { value: "event", label: "Event" },
  { value: "source", label: "Source" },
  { value: "coverage", label: "Coverage" },
  { value: "objective", label: "Objective" },
  { value: "remediation", label: "Remediation" },
];

const STATUS_LABEL: Record<AlertStatus, string> = {
  open: "待处理",
  acknowledged: "已确认",
  resolved: "已解决",
  silenced: "已静默",
};

const SEVERITY_LABEL: Record<SecuritySeverity, string> = {
  info: "提示",
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
};

const KIND_LABEL: Record<AlertKind, string> = {
  incident: "Incident",
  collector: "Collector",
  agent: "Agent",
  event: "Event",
  source: "Source",
  coverage: "Coverage",
  objective: "Objective",
  remediation: "Remediation",
};

function clean(value: string) {
  return value.trim() || undefined;
}

function formatDate(value?: string) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function toneBySeverity(severity?: SecuritySeverity) {
  if (severity === "critical" || severity === "high") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (severity === "medium") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (severity === "low") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  return "border-white/10 bg-white/5 text-zinc-300";
}

function toneByStatus(status?: AlertStatus) {
  if (status === "open") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (status === "acknowledged" || status === "silenced") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  return "border-teal-400/30 bg-teal-500/10 text-teal-100";
}

function toneByKind(kind?: AlertKind) {
  if (kind === "collector") return "border-sky-400/30 bg-sky-500/10 text-sky-100";
  if (kind === "agent") return "border-violet-400/30 bg-violet-500/10 text-violet-100";
  if (kind === "event") return "border-orange-400/30 bg-orange-500/10 text-orange-100";
  if (kind === "source") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  if (kind === "coverage") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (kind === "objective") return "border-cyan-400/30 bg-cyan-500/10 text-cyan-100";
  if (kind === "remediation") return "border-lime-400/30 bg-lime-500/10 text-lime-100";
  return "border-rose-400/30 bg-rose-500/10 text-rose-100";
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

function AlertRow({ alert, active, onSelect }: { alert: AlertListItem; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[86px_minmax(0,1fr)_76px_82px_82px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8",
      )}
    >
      <span className="font-mono text-xs text-zinc-500">{formatDate(alert.lastSeenAt)}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={alert.title}>{alert.title}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-600" title={alert.sourceSummary}>
          {alert.agentId ?? alert.sourceId ?? alert.collectorId ?? alert.riskCategory ?? alert.ruleId}
        </span>
      </span>
      <span><Pill className={toneByKind(alert.kind)}>{KIND_LABEL[alert.kind]}</Pill></span>
      <span><Pill className={toneBySeverity(alert.severity)}>{SEVERITY_LABEL[alert.severity]}</Pill></span>
      <span><Pill className={toneByStatus(alert.status)}>{STATUS_LABEL[alert.status]}</Pill></span>
    </button>
  );
}

function EvidenceLinks({ alert, timeType }: { alert: AlertListItem; timeType: SecurityTimeType }) {
  const eventQs = new URLSearchParams();
  if (alert.traceId) eventQs.set("traceId", alert.traceId);
  if (alert.eventId) eventQs.set("eventId", alert.eventId);
  if (alert.agentId) eventQs.set("agentId", alert.agentId);
  if (alert.workspacePath) eventQs.set("workspacePath", alert.workspacePath);
  if (alert.collectorId) eventQs.set("collectorId", alert.collectorId);
  if (alert.sourceId) eventQs.set("sourceId", alert.sourceId);
  const incidentQs = new URLSearchParams();
  if (alert.incidentId) incidentQs.set("incidentId", alert.incidentId);
  if (alert.traceId) incidentQs.set("traceId", alert.traceId);
  if (alert.agentId) incidentQs.set("agentId", alert.agentId);
  if (alert.workspacePath) incidentQs.set("workspacePath", alert.workspacePath);
  if (alert.collectorId) incidentQs.set("collectorId", alert.collectorId);
  if (alert.sourceId) incidentQs.set("sourceId", alert.sourceId);
  const collectorQs = new URLSearchParams();
  if (alert.collectorId) collectorQs.set("collectorId", alert.collectorId);
  const sourceQs = new URLSearchParams();
  if (alert.sourceId) sourceQs.set("sourceId", alert.sourceId);
  if (alert.collectorId) sourceQs.set("collectorId", alert.collectorId);
  if (alert.workspacePath) sourceQs.set("workspacePath", alert.workspacePath);
  const coverageQs = new URLSearchParams();
  if (alert.labels?.issueId) coverageQs.set("issueId", alert.labels.issueId);
  if (alert.labels?.type) coverageQs.set("type", alert.labels.type);
  if (alert.sourceId) coverageQs.set("sourceId", alert.sourceId);
  if (alert.collectorId) coverageQs.set("collectorId", alert.collectorId);
  if (alert.agentId) coverageQs.set("agentId", alert.agentId);
  if (alert.workspacePath) coverageQs.set("workspacePath", alert.workspacePath);
  const agentQs = new URLSearchParams();
  if (alert.agentId) agentQs.set("agentId", alert.agentId);
  if (alert.workspacePath) agentQs.set("workspacePath", alert.workspacePath);
  const objectiveQs = new URLSearchParams();
  if (alert.labels?.objectiveId) objectiveQs.set("objectiveId", alert.labels.objectiveId);
  const remediationQs = new URLSearchParams();
  if (alert.labels?.taskId) remediationQs.set("taskId", alert.labels.taskId);
  remediationQs.set("alertId", alert.alertId);
  if (alert.incidentId) remediationQs.set("incidentId", alert.incidentId);
  if (alert.eventId) remediationQs.set("eventId", alert.eventId);
  if (alert.labels?.objectiveId) remediationQs.set("objectiveId", alert.labels.objectiveId);
  if (alert.labels?.issueId) remediationQs.set("issueId", alert.labels.issueId);
  if (alert.sourceId) remediationQs.set("sourceId", alert.sourceId);
  if (alert.collectorId) remediationQs.set("collectorId", alert.collectorId);
  if (alert.agentId) remediationQs.set("agentId", alert.agentId);
  if (alert.workspacePath) remediationQs.set("workspacePath", alert.workspacePath);
  const bundleQs = new URLSearchParams({ timeType, alertId: alert.alertId });
  if (alert.incidentId) bundleQs.set("incidentId", alert.incidentId);
  if (alert.eventId) bundleQs.set("eventId", alert.eventId);
  if (alert.labels?.taskId) bundleQs.set("taskId", alert.labels.taskId);
  if (alert.labels?.objectiveId) bundleQs.set("objectiveId", alert.labels.objectiveId);
  if (alert.labels?.issueId) bundleQs.set("issueId", alert.labels.issueId);
  if (alert.traceId) bundleQs.set("traceId", alert.traceId);
  if (alert.runId) bundleQs.set("runId", alert.runId);
  if (alert.sessionId) bundleQs.set("sessionId", alert.sessionId);
  if (alert.agentId) bundleQs.set("agentId", alert.agentId);
  if (alert.workspacePath) bundleQs.set("workspacePath", alert.workspacePath);
  if (alert.collectorId) bundleQs.set("collectorId", alert.collectorId);
  if (alert.sourceId) bundleQs.set("sourceId", alert.sourceId);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
        <Link to={`/evidence?${bundleQs.toString()}`}>
          <FileText className="size-3.5" />
          证据包
        </Link>
      </Button>
      {alert.eventId || alert.traceId ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/events?${eventQs.toString()}`}>
            <Search className="size-3.5" />
            事件
          </Link>
        </Button>
      ) : null}
      {alert.incidentId ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/incidents?${incidentQs.toString()}`}>
            <ShieldAlert className="size-3.5" />
            Incident
          </Link>
        </Button>
      ) : null}
      {alert.collectorId ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/collectors?${collectorQs.toString()}`}>
            <RadioTower className="size-3.5" />
            Collector
          </Link>
        </Button>
      ) : null}
      {alert.sourceId ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/sources?${sourceQs.toString()}`}>
            <PlugZap className="size-3.5" />
            Source
          </Link>
        </Button>
      ) : null}
      {alert.labels?.issueId ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/coverage?${coverageQs.toString()}`}>
            <ShieldAlert className="size-3.5" />
            Coverage
          </Link>
        </Button>
      ) : null}
      {alert.agentId ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/agents?${agentQs.toString()}`}>
            <Bot className="size-3.5" />
            Agent
          </Link>
        </Button>
      ) : null}
      {alert.labels?.objectiveId ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/objectives?${objectiveQs.toString()}`}>
            <Target className="size-3.5" />
            Objective
          </Link>
        </Button>
      ) : null}
      {remediationQs.toString() ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/remediation?${remediationQs.toString()}`}>
            <FileCheck2 className="size-3.5" />
            Remediation
          </Link>
        </Button>
      ) : null}
    </div>
  );
}

function AlertDetail({
  alert,
  owner,
  note,
  silenceMinutes,
  saving,
  onOwnerChange,
  onNoteChange,
  onSilenceMinutesChange,
  onStatus,
  timeType,
}: {
  alert?: AlertListItem;
  owner: string;
  note: string;
  silenceMinutes: string;
  saving: boolean;
  onOwnerChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onSilenceMinutesChange: (value: string) => void;
  onStatus: (status: AlertStatus) => void;
  timeType: SecurityTimeType;
}) {
  if (!alert) {
    return (
      <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
        <div className="flex min-h-[360px] items-center justify-center text-sm text-zinc-500">选择一个告警查看处置详情</div>
      </section>
    );
  }

  const labelRows = Object.entries(alert.labels ?? {}).filter(([, value]) => value !== "");

  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <BellRing className="size-4 shrink-0 text-rose-200" />
          <h2 className="truncate text-sm font-semibold text-zinc-100">{alert.title}</h2>
        </div>
        <Pill className={toneByStatus(alert.status)}>{STATUS_LABEL[alert.status]}</Pill>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FieldValue label="Alert ID" value={alert.alertId} />
          <FieldValue label="Rule" value={alert.ruleId} />
          <FieldValue label="Dedupe" value={alert.dedupeKey} />
          <FieldValue label="Agent" value={alert.agentId} />
          <FieldValue label="Workspace" value={alert.workspacePath} />
          <FieldValue label="Collector" value={alert.collectorId} />
          <FieldValue label="Source" value={alert.sourceId} />
          <FieldValue label="Team" value={alert.team} />
          <FieldValue label="Node" value={alert.nodeName} />
          <FieldValue label="Trace" value={alert.traceId} />
          <FieldValue label="Incident" value={alert.incidentId} />
          <FieldValue label="Event" value={alert.eventId} />
          <FieldValue label="Risk" value={alert.riskName ?? alert.riskCategory} />
          <FieldValue label="First Seen" value={formatDate(alert.firstSeenAt)} />
          <FieldValue label="Last Seen" value={formatDate(alert.lastSeenAt)} />
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">等级</p>
            <p className="mt-1 text-sm font-semibold text-zinc-100">{SEVERITY_LABEL[alert.severity]}</p>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">触发次数</p>
            <p className="mt-1 font-mono text-2xl font-semibold text-zinc-100">{alert.occurrenceCount}</p>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">通知</p>
            <p className="mt-1 truncate font-mono text-xs text-zinc-300">{formatDate(alert.lastNotificationAt)}</p>
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">描述</p>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">{alert.description}</div>
        </div>

        {labelRows.length ? (
          <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
            <div className="mb-2 flex items-center gap-2">
              <TerminalSquare className="size-4 text-teal-200" />
              <h3 className="text-sm font-semibold text-zinc-100">Labels</h3>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {labelRows.map(([key, value]) => <FieldValue key={key} label={key} value={value} />)}
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px]">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-400">负责人</span>
            <Input value={owner} onChange={(event) => onOwnerChange(event.target.value)} placeholder="operator / team" className="h-9 border-white/10 bg-white/5 text-xs" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-400">备注</span>
            <Input value={note} onChange={(event) => onNoteChange(event.target.value)} placeholder="处置说明" className="h-9 border-white/10 bg-white/5 text-xs" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-400">静默分钟</span>
            <Input value={silenceMinutes} onChange={(event) => onSilenceMinutesChange(event.target.value.replace(/\D/g, "").slice(0, 5))} className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={saving} onClick={() => onStatus("acknowledged")} className="h-8 bg-amber-400 text-[#171004] hover:bg-amber-300">
            {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <UserCheck className="size-3.5" />}
            确认
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => onStatus("resolved")} className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            <CheckCircle2 className="size-3.5" />
            解决
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => onStatus("silenced")} className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Clock3 className="size-3.5" />
            静默
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => onStatus("open")} className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <RotateCcw className="size-3.5" />
            重开
          </Button>
        </div>

        <EvidenceLinks alert={alert} timeType={timeType} />
      </div>
    </section>
  );
}

export default function AlertsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const [status, setStatus] = useState<AlertStatus | "all">((searchParams.get("status") as AlertStatus) || "all");
  const [severity, setSeverity] = useState<SecuritySeverity | "all">((searchParams.get("severity") as SecuritySeverity) || "all");
  const [kind, setKind] = useState<AlertKind | "all">((searchParams.get("kind") as AlertKind) || "all");
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const [selectedAlertId, setSelectedAlertId] = useState(searchParams.get("alertId") ?? "");
  const [owner, setOwner] = useState("");
  const [note, setNote] = useState("");
  const [silenceMinutes, setSilenceMinutes] = useState("60");
  const [saving, setSaving] = useState(false);
  const routeWorkspacePath = searchParams.get("workspacePath") ?? "";
  const routeAgentId = searchParams.get("agentId") ?? "";
  const routeCollectorId = searchParams.get("collectorId") ?? "";
  const routeSourceId = searchParams.get("sourceId") ?? "";
  const routeIncidentId = searchParams.get("incidentId") ?? "";
  const routeEventId = searchParams.get("eventId") ?? "";
  const routeTaskId = searchParams.get("taskId") ?? "";
  const routeObjectiveId = searchParams.get("objectiveId") ?? "";
  const routeIssueId = searchParams.get("issueId") ?? "";

  const query = useMemo<AlertListQuery>(() => ({
    timeType,
    alertId: clean(selectedAlertId),
    status,
    severity,
    kind,
    q: clean(queryText),
    workspacePath: clean(routeWorkspacePath),
    agentId: clean(routeAgentId),
    collectorId: clean(routeCollectorId),
    sourceId: clean(routeSourceId),
    incidentId: clean(routeIncidentId),
    eventId: clean(routeEventId),
    taskId: clean(routeTaskId),
    objectiveId: clean(routeObjectiveId),
    issueId: clean(routeIssueId),
    limit: 200,
  }), [kind, queryText, routeAgentId, routeCollectorId, routeEventId, routeIncidentId, routeIssueId, routeObjectiveId, routeSourceId, routeTaskId, routeWorkspacePath, selectedAlertId, severity, status, timeType]);

  const { data, loading, refresh } = useRequest(() => securityCenterApi.alerts(query), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const selectedAlert = useMemo(() => {
    const items = data?.items ?? [];
    return items.find((item) => item.alertId === selectedAlertId) ?? items[0];
  }, [data, selectedAlertId]);

  const selectAlert = (alert: AlertListItem) => {
    setSelectedAlertId(alert.alertId);
    setOwner(alert.owner ?? "");
    setNote(alert.note ?? "");
    const next = new URLSearchParams();
    next.set("timeType", timeType);
    next.set("alertId", alert.alertId);
    next.set("kind", alert.kind);
    if (alert.incidentId) next.set("incidentId", alert.incidentId);
    if (alert.eventId) next.set("eventId", alert.eventId);
    if (alert.labels?.taskId) next.set("taskId", alert.labels.taskId);
    if (alert.labels?.objectiveId) next.set("objectiveId", alert.labels.objectiveId);
    if (alert.labels?.issueId) next.set("issueId", alert.labels.issueId);
    if (alert.agentId) next.set("agentId", alert.agentId);
    if (alert.workspacePath) next.set("workspacePath", alert.workspacePath);
    if (alert.collectorId) next.set("collectorId", alert.collectorId);
    if (alert.sourceId) next.set("sourceId", alert.sourceId);
    setSearchParams(next);
  };

  const clearFilters = () => {
    setStatus("all");
    setSeverity("all");
    setKind("all");
    setQueryText("");
    setSelectedAlertId("");
    setOwner("");
    setNote("");
    setSearchParams({});
  };

  const updateStatus = async (nextStatus: AlertStatus) => {
    if (!selectedAlert) return;
    setSaving(true);
    try {
      const updated = await securityCenterApi.updateAlert(selectedAlert.alertId, {
        status: nextStatus,
        owner: clean(owner),
        note: clean(note),
        silenceMinutes: nextStatus === "silenced" ? Number(silenceMinutes || 60) : undefined,
      });
      setSelectedAlertId(updated.alertId);
      setOwner(updated.owner ?? "");
      setNote(updated.note ?? "");
      await refresh();
    } finally {
      setSaving(false);
    }
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
                <Siren className="size-5 shrink-0 text-rose-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">告警中心</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">Incident · Collector · Agent · Event · Source · Objective · Remediation</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <span className={cn("rounded-full border px-2 py-0.5", data?.webhookConfigured ? "border-teal-400/25 bg-teal-500/10 text-teal-100" : "border-white/10 bg-white/5")}>
              Webhook {data?.webhookConfigured ? "on" : "off"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="size-3.5" />
              {data?.updateTime ? formatDate(data.updateTime) : "等待刷新"}
            </span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[120px_130px_130px_130px_minmax(180px,1fr)_auto_auto]">
          <Select value={timeType} onValueChange={(next) => setTimeType(next as SecurityTimeType)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={status} onValueChange={(next) => setStatus(next as AlertStatus | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{STATUS_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={severity} onValueChange={(next) => setSeverity(next as SecuritySeverity | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{SEVERITY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={kind} onValueChange={(next) => setKind(next as AlertKind | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{KIND_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="alert / agent / collector / source / owner / team / risk" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Button type="button" variant="secondary" size="sm" onClick={clearFilters} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <X className="size-3.5" />
            清除
          </Button>
          <Button type="button" size="sm" onClick={refresh} disabled={loading} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <MetricTile label="活跃告警" value={data?.summary.activeAlerts ?? 0} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
            <MetricTile label="待处理" value={data?.summary.openAlerts ?? 0} tone="border-orange-400/25 bg-orange-500/10 text-orange-100" />
            <MetricTile label="已确认" value={data?.summary.acknowledgedAlerts ?? 0} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
            <MetricTile label="静默" value={data?.summary.silencedAlerts ?? 0} tone="border-sky-400/25 bg-sky-500/10 text-sky-100" />
            <MetricTile label="严重/高" value={(data?.summary.criticalAlerts ?? 0) + (data?.summary.highAlerts ?? 0)} tone="border-fuchsia-400/25 bg-fuchsia-500/10 text-fuchsia-100" />
            <MetricTile label="总数" value={data?.summary.totalAlerts ?? 0} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(560px,1fr)_minmax(0,1.25fr)]">
            <section className="min-h-[620px] rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <BellRing className="size-4 text-rose-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">Alerts</h2>
                </div>
                <span className="text-xs text-zinc-500">{data ? `${data.total} 条` : "--"}</span>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  加载告警...
                </div>
              ) : (data?.items?.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">暂无告警</div>
              ) : (
                <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
                  {data?.items.map((alert) => (
                    <AlertRow
                      key={alert.alertId}
                      alert={alert}
                      active={alert.alertId === selectedAlert?.alertId}
                      onSelect={() => selectAlert(alert)}
                    />
                  ))}
                </div>
              )}
            </section>

            <div className="space-y-4">
              <AlertDetail
                alert={selectedAlert}
                owner={owner}
                note={note}
                silenceMinutes={silenceMinutes}
                saving={saving}
                timeType={timeType}
                onOwnerChange={setOwner}
                onNoteChange={setNote}
                onSilenceMinutesChange={setSilenceMinutes}
                onStatus={updateStatus}
              />
              <section className="rounded-[8px] border border-white/10 bg-[#111612]/92 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <ShieldAlert className="size-4 text-teal-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">规则</h2>
                </div>
                <div className="grid gap-2 lg:grid-cols-2">
                  {(data?.rules ?? []).map((rule) => (
                    <div key={rule.ruleId} className="min-w-0 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-xs font-semibold text-zinc-100" title={rule.name}>{rule.name}</p>
                        <Pill className={rule.enabled ? "border-teal-400/30 bg-teal-500/10 text-teal-100" : "border-white/10 bg-white/5 text-zinc-400"}>
                          {rule.enabled ? "on" : "off"}
                        </Pill>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500">{rule.description}</p>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
