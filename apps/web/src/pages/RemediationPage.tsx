import { useRequest } from "ahooks";
import dayjs from "dayjs";
import {
  AlertTriangle,
  ArrowLeft,
  BellRing,
  Bot,
  CheckCircle2,
  Clock3,
  EyeOff,
  FileCheck2,
  FileText,
  LoaderCircle,
  PlugZap,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
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
  type RemediationActionKind,
  type RemediationListItem,
  type RemediationQuery,
  type RemediationSourceType,
  type RemediationStatus,
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

function formatDate(value?: string) {
  if (!value) return "--";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("MM-DD HH:mm:ss") : value;
}

function toDateTimeLocal(value?: string) {
  if (!value) return "";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("YYYY-MM-DDTHH:mm") : "";
}

function fromDateTimeLocal(value: string) {
  if (!value) return "";
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.toISOString() : "";
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

function TaskRow({
  task,
  active,
  onSelect,
}: {
  task: RemediationListItem;
  active: boolean;
  onSelect: () => void;
}) {
  const doneSteps = task.steps.filter((step) => step.done).length;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[86px_minmax(0,1fr)_82px_78px_76px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8",
      )}
    >
      <span className="font-mono text-xs text-zinc-500">{formatDate(task.updatedAt)}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={task.title}>{task.title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-zinc-600" title={task.description}>
          {task.agentId ?? task.collectorId ?? task.ingestionSourceId ?? task.workspacePath ?? task.actionKind} · {doneSteps}/{task.steps.length}
        </span>
      </span>
      <span><Pill className={toneBySource(task.sourceType)}>{SOURCE_LABEL[task.sourceType]}</Pill></span>
      <span><Pill className={toneBySeverity(task.severity)}>{SEVERITY_LABEL[task.severity]}</Pill></span>
      <span><Pill className={toneByStatus(task.status)}>{STATUS_LABEL[task.status]}</Pill></span>
    </button>
  );
}

function EvidenceLinks({ task, timeType }: { task: RemediationListItem; timeType: SecurityTimeType }) {
  const eventQs = new URLSearchParams();
  if (task.eventId) eventQs.set("eventId", task.eventId);
  if (task.traceId) eventQs.set("traceId", task.traceId);
  if (task.agentId) eventQs.set("agentId", task.agentId);
  if (task.workspacePath) eventQs.set("workspacePath", task.workspacePath);
  if (task.collectorId) eventQs.set("collectorId", task.collectorId);
  if (task.ingestionSourceId) eventQs.set("sourceId", task.ingestionSourceId);
  const incidentQs = new URLSearchParams();
  if (task.incidentId) incidentQs.set("incidentId", task.incidentId);
  if (task.traceId) incidentQs.set("traceId", task.traceId);
  if (task.agentId) incidentQs.set("agentId", task.agentId);
  if (task.workspacePath) incidentQs.set("workspacePath", task.workspacePath);
  if (task.collectorId) incidentQs.set("collectorId", task.collectorId);
  if (task.ingestionSourceId) incidentQs.set("sourceId", task.ingestionSourceId);
  const alertQs = new URLSearchParams();
  if (task.alertId) alertQs.set("alertId", task.alertId);
  if (task.agentId) alertQs.set("agentId", task.agentId);
  if (task.workspacePath) alertQs.set("workspacePath", task.workspacePath);
  if (task.collectorId) alertQs.set("collectorId", task.collectorId);
  if (task.ingestionSourceId) alertQs.set("sourceId", task.ingestionSourceId);
  const coverageQs = new URLSearchParams();
  if (task.sourceType === "coverage") coverageQs.set("issueId", task.sourceId);
  if (task.agentId) coverageQs.set("agentId", task.agentId);
  if (task.collectorId) coverageQs.set("collectorId", task.collectorId);
  if (task.ingestionSourceId) coverageQs.set("sourceId", task.ingestionSourceId);
  if (task.workspacePath) coverageQs.set("workspacePath", task.workspacePath);
  const agentQs = new URLSearchParams();
  if (task.agentId) agentQs.set("agentId", task.agentId);
  if (task.workspacePath) agentQs.set("workspacePath", task.workspacePath);
  const collectorQs = new URLSearchParams();
  if (task.collectorId) collectorQs.set("collectorId", task.collectorId);
  const sourceQs = new URLSearchParams();
  if (task.ingestionSourceId) sourceQs.set("sourceId", task.ingestionSourceId);
  if (task.collectorId) sourceQs.set("collectorId", task.collectorId);
  if (task.workspacePath) sourceQs.set("workspacePath", task.workspacePath);
  const bundleQs = new URLSearchParams({ timeType, taskId: task.taskId });
  if (task.eventId) bundleQs.set("eventId", task.eventId);
  if (task.incidentId) bundleQs.set("incidentId", task.incidentId);
  if (task.alertId) bundleQs.set("alertId", task.alertId);
  if (task.labels?.objectiveId) bundleQs.set("objectiveId", task.labels.objectiveId);
  if (task.sourceType === "coverage") bundleQs.set("issueId", task.sourceId);
  if (task.traceId) bundleQs.set("traceId", task.traceId);
  if (task.agentId) bundleQs.set("agentId", task.agentId);
  if (task.workspacePath) bundleQs.set("workspacePath", task.workspacePath);
  if (task.collectorId) bundleQs.set("collectorId", task.collectorId);
  if (task.ingestionSourceId) bundleQs.set("sourceId", task.ingestionSourceId);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
        <Link to={`/evidence?${bundleQs.toString()}`}>
          <FileText className="size-3.5" />
          证据包
        </Link>
      </Button>
      {eventQs.toString() ? (
        <Button asChild size="sm" className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
          <Link to={`/events?${eventQs.toString()}`}>
            <Search className="size-3.5" />
            事件
          </Link>
        </Button>
      ) : null}
      {task.incidentId ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/incidents?${incidentQs.toString()}`}>
            <ShieldAlert className="size-3.5" />
            Incident
          </Link>
        </Button>
      ) : null}
      {task.alertId ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/alerts?${alertQs.toString()}`}>
            <BellRing className="size-3.5" />
            Alert
          </Link>
        </Button>
      ) : null}
      {task.sourceType === "coverage" ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/coverage?${coverageQs.toString()}`}>
            <EyeOff className="size-3.5" />
            Coverage
          </Link>
        </Button>
      ) : null}
      {task.agentId ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/agents?${agentQs.toString()}`}>
            <Bot className="size-3.5" />
            Agent
          </Link>
        </Button>
      ) : null}
      {task.collectorId ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/collectors?${collectorQs.toString()}`}>
            <RadioTower className="size-3.5" />
            Collector
          </Link>
        </Button>
      ) : null}
      {task.ingestionSourceId ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/sources?${sourceQs.toString()}`}>
            <PlugZap className="size-3.5" />
            Source
          </Link>
        </Button>
      ) : null}
    </div>
  );
}

function TaskDetail({
  task,
  owner,
  note,
  dueAt,
  saving,
  timeType,
  onOwnerChange,
  onNoteChange,
  onDueAtChange,
  onStatus,
  onToggleStep,
}: {
  task?: RemediationListItem;
  owner: string;
  note: string;
  dueAt: string;
  saving: boolean;
  timeType: SecurityTimeType;
  onOwnerChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onDueAtChange: (value: string) => void;
  onStatus: (status: RemediationStatus) => void;
  onToggleStep: (stepId: string) => void;
}) {
  if (!task) {
    return (
      <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
        <div className="flex min-h-[360px] items-center justify-center text-sm text-zinc-500">选择一个处置任务查看 Runbook</div>
      </section>
    );
  }

  const labelRows = Object.entries(task.labels ?? {}).filter(([, value]) => value !== "");

  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileCheck2 className="size-4 shrink-0 text-teal-200" />
          <h2 className="truncate text-sm font-semibold text-zinc-100">{task.title}</h2>
        </div>
        <Pill className={toneByStatus(task.status)}>{STATUS_LABEL[task.status]}</Pill>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <FieldValue label="Task ID" value={task.taskId} />
          <FieldValue label="Source" value={`${task.sourceType}:${task.sourceId}`} />
          <FieldValue label="Action" value={ACTION_LABEL[task.actionKind]} />
          <FieldValue label="Agent" value={task.agentId} />
          <FieldValue label="Workspace" value={task.workspacePath} />
          <FieldValue label="Collector" value={task.collectorId} />
          <FieldValue label="Ingestion Source" value={task.ingestionSourceId} />
          <FieldValue label="Created" value={formatDate(task.createdAt)} />
          <FieldValue label="Updated" value={formatDate(task.updatedAt)} />
          <FieldValue label="Due" value={formatDate(task.dueAt)} />
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">描述</p>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">{task.description}</div>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">建议动作</p>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">{task.recommendedAction}</div>
        </div>

        <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-zinc-100">Runbook</h3>
            <span className="text-[11px] text-zinc-500">{task.steps.filter((step) => step.done).length}/{task.steps.length}</span>
          </div>
          <div className="space-y-2">
            {task.steps.map((step) => (
              <button
                key={step.stepId}
                type="button"
                onClick={() => onToggleStep(step.stepId)}
                disabled={saving}
                className={cn(
                  "grid w-full grid-cols-[20px_minmax(0,1fr)] gap-2 rounded-md border px-3 py-2 text-left transition",
                  step.done ? "border-teal-400/25 bg-teal-500/10" : "border-white/10 bg-[#111612]/70 hover:bg-white/[0.05]",
                )}
              >
                <span className={cn("mt-0.5 inline-flex size-4 items-center justify-center rounded-full border", step.done ? "border-teal-300 bg-teal-400 text-[#07100c]" : "border-white/20 text-zinc-500")}>
                  {step.done ? <CheckCircle2 className="size-3" /> : null}
                </span>
                <span className="min-w-0">
                  <span className={cn("block truncate text-xs font-medium", step.done ? "text-teal-100" : "text-zinc-100")} title={step.title}>{step.title}</span>
                  {step.detail ? <span className="mt-0.5 block truncate text-[11px] text-zinc-500" title={step.detail}>{step.detail}</span> : null}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_190px]">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-400">负责人</span>
            <Input value={owner} onChange={(event) => onOwnerChange(event.target.value)} placeholder="operator / team" className="h-9 border-white/10 bg-white/5 text-xs" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-400">备注</span>
            <Input value={note} onChange={(event) => onNoteChange(event.target.value)} placeholder="处置说明" className="h-9 border-white/10 bg-white/5 text-xs" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-400">截止时间</span>
            <Input type="datetime-local" value={dueAt} onChange={(event) => onDueAtChange(event.target.value)} className="h-9 border-white/10 bg-white/5 text-xs" />
          </label>
        </div>

        {labelRows.length ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {labelRows.map(([key, value]) => <FieldValue key={key} label={key} value={value} />)}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={saving} onClick={() => onStatus("in_progress")} className="h-8 bg-amber-400 text-[#171004] hover:bg-amber-300">
            {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <UserCheck className="size-3.5" />}
            处理中
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => onStatus("done")} className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            <CheckCircle2 className="size-3.5" />
            完成
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => onStatus("blocked")} className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <AlertTriangle className="size-3.5" />
            阻塞
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => onStatus("open")} className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <RotateCcw className="size-3.5" />
            重开
          </Button>
        </div>

        <EvidenceLinks task={task} timeType={timeType} />
      </div>
    </section>
  );
}

export default function RemediationPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const [status, setStatus] = useState<RemediationStatus | "all">((searchParams.get("status") as RemediationStatus) || "all");
  const [sourceType, setSourceType] = useState<RemediationSourceType | "all">((searchParams.get("sourceType") as RemediationSourceType) || "all");
  const [severity, setSeverity] = useState<SecuritySeverity | "all">((searchParams.get("severity") as SecuritySeverity) || "all");
  const [queryText, setQueryText] = useState(searchParams.get("q") ?? "");
  const [selectedTaskId, setSelectedTaskId] = useState(searchParams.get("taskId") ?? "");
  const [owner, setOwner] = useState("");
  const [note, setNote] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [saving, setSaving] = useState(false);
  const routeWorkspacePath = searchParams.get("workspacePath") ?? "";
  const routeAgentId = searchParams.get("agentId") ?? "";
  const routeCollectorId = searchParams.get("collectorId") ?? "";
  const routeSourceId = searchParams.get("sourceId") ?? "";
  const routeIncidentId = searchParams.get("incidentId") ?? "";
  const routeAlertId = searchParams.get("alertId") ?? "";
  const routeEventId = searchParams.get("eventId") ?? "";
  const routeObjectiveId = searchParams.get("objectiveId") ?? "";
  const routeIssueId = searchParams.get("issueId") ?? "";

  const query = useMemo<RemediationQuery>(() => ({
    timeType,
    taskId: clean(selectedTaskId),
    incidentId: clean(routeIncidentId),
    alertId: clean(routeAlertId),
    eventId: clean(routeEventId),
    objectiveId: clean(routeObjectiveId),
    issueId: clean(routeIssueId),
    status,
    sourceType,
    severity,
    q: clean(queryText),
    workspacePath: clean(routeWorkspacePath),
    agentId: clean(routeAgentId),
    collectorId: clean(routeCollectorId),
    sourceId: clean(routeSourceId),
    limit: 200,
  }), [queryText, routeAgentId, routeAlertId, routeCollectorId, routeEventId, routeIncidentId, routeIssueId, routeObjectiveId, routeSourceId, routeWorkspacePath, selectedTaskId, severity, sourceType, status, timeType]);

  const { data, loading, refresh } = useRequest(() => securityCenterApi.remediations(query), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const selectedTask = useMemo(() => {
    const items = data?.items ?? [];
    return items.find((item) => item.taskId === selectedTaskId) ?? items[0];
  }, [data, selectedTaskId]);

  const selectTask = (task: RemediationListItem) => {
    setSelectedTaskId(task.taskId);
    setOwner(task.owner ?? "");
    setNote(task.note ?? "");
    setDueAt(toDateTimeLocal(task.dueAt));
    const next = new URLSearchParams();
    next.set("timeType", timeType);
    next.set("taskId", task.taskId);
    next.set("sourceType", task.sourceType);
    if (task.agentId) next.set("agentId", task.agentId);
    if (task.workspacePath) next.set("workspacePath", task.workspacePath);
    if (task.collectorId) next.set("collectorId", task.collectorId);
    if (task.ingestionSourceId) next.set("sourceId", task.ingestionSourceId);
    if (task.incidentId) next.set("incidentId", task.incidentId);
    if (task.alertId) next.set("alertId", task.alertId);
    if (task.eventId) next.set("eventId", task.eventId);
    if (task.labels?.objectiveId) next.set("objectiveId", task.labels.objectiveId);
    if (task.sourceType === "coverage") next.set("issueId", task.sourceId);
    setSearchParams(next);
  };

  const clearFilters = () => {
    setStatus("all");
    setSourceType("all");
    setSeverity("all");
    setQueryText("");
    setSelectedTaskId("");
    setOwner("");
    setNote("");
    setDueAt("");
    setSearchParams({});
  };

  const updateTask = async (task: RemediationListItem, nextStatus?: RemediationStatus, completedStepIds?: string[]) => {
    setSaving(true);
    try {
      const updated = await securityCenterApi.updateRemediation(task.taskId, {
        status: nextStatus ?? task.status,
        owner: clean(owner),
        note: clean(note),
        dueAt: dueAt ? fromDateTimeLocal(dueAt) : undefined,
        completedStepIds,
      });
      setSelectedTaskId(updated.taskId);
      setOwner(updated.owner ?? "");
      setNote(updated.note ?? "");
      setDueAt(toDateTimeLocal(updated.dueAt));
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (nextStatus: RemediationStatus) => {
    if (!selectedTask) return;
    await updateTask(selectedTask, nextStatus);
  };

  const toggleStep = async (stepId: string) => {
    if (!selectedTask) return;
    const current = new Set(selectedTask.steps.filter((step) => step.done).map((step) => step.stepId));
    if (current.has(stepId)) current.delete(stepId);
    else current.add(stepId);
    await updateTask(selectedTask, selectedTask.status, [...current]);
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
                <FileCheck2 className="size-5 shrink-0 text-teal-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">处置中心</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">Incident · Alert · Coverage Runbook</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <AdminTokenControl compact />
            <Clock3 className="size-3.5" />
            <span>{data?.updateTime ? formatDate(data.updateTime) : "等待刷新"}</span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[120px_130px_130px_130px_minmax(180px,1fr)_auto_auto]">
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
          <Input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="task / agent / collector / source" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
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
            <MetricTile label="活跃任务" value={data?.summary.activeTasks ?? 0} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
            <MetricTile label="处理中" value={data?.summary.inProgressTasks ?? 0} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
            <MetricTile label="阻塞" value={data?.summary.blockedTasks ?? 0} tone="border-orange-400/25 bg-orange-500/10 text-orange-100" />
            <MetricTile label="逾期" value={data?.summary.overdueTasks ?? 0} tone="border-fuchsia-400/25 bg-fuchsia-500/10 text-fuchsia-100" />
            <MetricTile label="高优先级" value={data?.summary.highPriorityTasks ?? 0} tone="border-sky-400/25 bg-sky-500/10 text-sky-100" />
            <MetricTile label="总数" value={data?.summary.totalTasks ?? 0} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(560px,1fr)_minmax(0,1.15fr)]">
            <section className="min-h-[620px] rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <FileCheck2 className="size-4 text-teal-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">Runbooks</h2>
                </div>
                <span className="text-xs text-zinc-500">{data ? `${data.total} 条` : "--"}</span>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  加载处置任务...
                </div>
              ) : (data?.items?.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">暂无处置任务</div>
              ) : (
                <div className="max-h-[calc(100vh-320px)] overflow-y-auto">
                  {data?.items.map((task) => (
                    <TaskRow
                      key={task.taskId}
                      task={task}
                      active={task.taskId === selectedTask?.taskId}
                      onSelect={() => selectTask(task)}
                    />
                  ))}
                </div>
              )}
            </section>

            <div className="space-y-4">
              <TaskDetail
                task={selectedTask}
                owner={owner}
                note={note}
                dueAt={dueAt}
                saving={saving}
                timeType={timeType}
                onOwnerChange={setOwner}
                onNoteChange={setNote}
                onDueAtChange={setDueAt}
                onStatus={updateStatus}
                onToggleStep={toggleStep}
              />
              <section className="rounded-[8px] border border-white/10 bg-[#111612]/92 p-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <FieldValue label="Incident Tasks" value={data?.summary.incidentTasks ?? 0} />
                  <FieldValue label="Alert Tasks" value={data?.summary.alertTasks ?? 0} />
                  <FieldValue label="Coverage Tasks" value={data?.summary.coverageTasks ?? 0} />
                  <FieldValue label="Done" value={data?.summary.doneTasks ?? 0} />
                  <FieldValue label="Dismissed" value={data?.summary.dismissedTasks ?? 0} />
                  <FieldValue label="Open" value={data?.summary.openTasks ?? 0} />
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
