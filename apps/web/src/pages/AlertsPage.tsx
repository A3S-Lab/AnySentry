import { useRequest } from "ahooks";
import { formatSecurityDateTime } from "@/lib/date-time";
import {
  Activity,
  ArrowLeft,
  BellRing,
  Bot,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FileText,
  FileCheck2,
  GitBranch,
  LayoutDashboard,
  LoaderCircle,
  PlugZap,
  Radar,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  ShieldAlert,
  Siren,
  Sparkles,
  ServerCog,
  Target,
  TerminalSquare,
  UserCheck,
  Wrench,
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
  type AlertTimeMode,
  type SecuritySeverity,
  type SecurityTimeType,
  securityCenterApi,
} from "@/lib/api/security-center";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const TIME_OPTIONS: Array<{ value: SecurityTimeType; label: string }> = [
  { value: "last_30m", label: "近30分钟" },
  { value: "last_1h", label: "近1小时" },
  { value: "last_2h", label: "近2小时" },
  { value: "last_3h", label: "近3小时" },
  { value: "last_1d", label: "近一天" },
  { value: "last_7d", label: "近一周" },
  { value: "last_30d", label: "近一月" },
];

type AlertStatusFilter = NonNullable<AlertListQuery["status"]>;

const STATUS_OPTIONS: Array<{ value: AlertStatusFilter; label: string }> = [
  { value: "active", label: "需要处理" },
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
  { value: "incident", label: "安全事件" },
  { value: "collector", label: "采集链路" },
  { value: "agent", label: "Agent 聚集" },
  { value: "event", label: "证据事件" },
  { value: "judgment", label: "研判服务" },
  { value: "source", label: "接入源" },
  { value: "coverage", label: "覆盖盲区" },
  { value: "objective", label: "监控目标" },
  { value: "remediation", label: "处置逾期" },
];

type AlertScope = NonNullable<AlertListQuery["scope"]>;

function AlertScopeTabs({
  value,
  onChange,
}: {
  value: AlertScope;
  onChange: (value: AlertScope) => void;
}) {
  const { t } = useI18n();
  const options: Array<{ value: AlertScope; label: string }> = [
    { value: "agent", label: "Agent 相关" },
    { value: "raw", label: "全部观测" },
  ];

  return (
    <div className="inline-flex h-9 items-center rounded-md border border-white/10 bg-white/5 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "h-8 min-w-20 rounded px-2.5 text-xs font-semibold transition-colors",
            value === option.value
              ? "bg-teal-400/20 text-teal-100"
              : "text-zinc-500 hover:bg-white/5 hover:text-zinc-200",
          )}
        >
          {t(option.label)}
        </button>
      ))}
    </div>
  );
}

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
  incident: "安全事件",
  collector: "采集链路",
  agent: "Agent 聚集",
  event: "证据事件",
  judgment: "研判服务",
  source: "接入源",
  coverage: "覆盖盲区",
  objective: "监控目标",
  remediation: "处置逾期",
};

const MONITORING_NAV_ITEMS = [
  { view: "overview", label: "运行总览", description: "平台健康与实时状态", icon: Activity },
  { view: "scan", label: "实时扫描", description: "可解释扫描与研判漏斗", icon: Radar },
  { view: "risk", label: "风险态势", description: "风险分类与趋势分布", icon: Siren },
  { view: "stream", label: "复合研判", description: "Flink 连续行为关联", icon: Sparkles },
  { view: "supplyChain", label: "供应链漏洞", description: "OSV 依赖漏洞资产", icon: ShieldAlert },
  { view: "events", label: "运行链路", description: "无侵入事件时间线", icon: GitBranch },
  { view: "workspace", label: "会话与工作区", description: "Agent 与 Workspace 风险", icon: TerminalSquare },
] as const;

function clean(value: string) {
  return value.trim() || undefined;
}

function formatDate(value?: string) {
  return formatSecurityDateTime(value, "MM-DD HH:mm:ss", value || "--");
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
  if (kind === "judgment") return "border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-100";
  if (kind === "collector") return "border-sky-400/30 bg-sky-500/10 text-sky-100";
  if (kind === "agent") return "border-violet-400/30 bg-violet-500/10 text-violet-100";
  if (kind === "event") return "border-orange-400/30 bg-orange-500/10 text-orange-100";
  if (kind === "source") return "border-teal-400/30 bg-teal-500/10 text-teal-100";
  if (kind === "coverage") return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  if (kind === "objective") return "border-cyan-400/30 bg-cyan-500/10 text-cyan-100";
  if (kind === "remediation") return "border-lime-400/30 bg-lime-500/10 text-lime-100";
  return "border-rose-400/30 bg-rose-500/10 text-rose-100";
}

function AlertTimeModeTabs({
  value,
  onChange,
}: {
  value: AlertTimeMode;
  onChange: (value: AlertTimeMode) => void;
}) {
  const { t } = useI18n();
  const options: Array<{ value: AlertTimeMode; label: string }> = [
    { value: "window", label: "当前窗口" },
    { value: "backlog", label: "活跃积压" },
  ];
  return (
    <div className="inline-flex h-9 items-center rounded-md border border-white/10 bg-white/5 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "h-8 min-w-20 rounded px-2.5 text-xs font-semibold transition-colors",
            value === option.value
              ? "bg-orange-400/15 text-orange-100"
              : "text-zinc-500 hover:bg-white/5 hover:text-zinc-200",
          )}
        >
          {t(option.label)}
        </button>
      ))}
    </div>
  );
}

function Pill({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", className)}>
      {children}
    </span>
  );
}

function MetricTile({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  const { t } = useI18n();
  return (
    <div className={cn("rounded-[8px] border px-4 py-3", tone)}>
      <p className="text-xs opacity-80">{t(label)}</p>
      <p className="mt-1 truncate font-mono text-2xl font-semibold">{value}</p>
    </div>
  );
}

function FieldValue({ label, value }: { label: string; value?: string | number }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-zinc-600">{t(label)}</p>
      <p className="mt-1 truncate font-mono text-xs text-zinc-300" title={String(value ?? "")}>
        {value ?? "--"}
      </p>
    </div>
  );
}

function AlertRow({ alert, active, onSelect }: { alert: AlertListItem; active: boolean; onSelect: () => void }) {
  const { t } = useI18n();
  const scope = [
    alert.agentId,
    alert.workspacePath?.split("/").filter(Boolean).at(-1),
  ].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[86px_minmax(0,1fr)_92px_54px_66px] items-center gap-3 border-b border-white/8 px-3 py-3 text-left transition hover:bg-white/[0.05]",
        active && "bg-teal-400/8 shadow-[inset_3px_0_0_#2dd4bf]",
      )}
    >
      <span className="font-mono text-xs text-zinc-500">{formatDate(alert.lastSeenAt)}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-100" title={alert.title}>{alert.title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-zinc-500" title={`${scope} ${alert.sourceSummary}`}>
          {scope || alert.sourceId || alert.collectorId || alert.riskCategory || alert.ruleId}
        </span>
      </span>
      <span><Pill className={toneByKind(alert.kind)}>{KIND_LABEL[alert.kind]}</Pill></span>
      <span><Pill className={toneBySeverity(alert.severity)}>{t(SEVERITY_LABEL[alert.severity])}</Pill></span>
      <span><Pill className={toneByStatus(alert.status)}>{t(STATUS_LABEL[alert.status])}</Pill></span>
    </button>
  );
}

function EvidenceLinks({ alert, timeType }: { alert: AlertListItem; timeType: SecurityTimeType }) {
  const { t } = useI18n();
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
          {t("证据包")}
        </Link>
      </Button>
      {alert.eventId || alert.traceId ? (
        <Button asChild variant="secondary" size="sm" className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
          <Link to={`/events?${eventQs.toString()}`}>
            <Search className="size-3.5" />
            {t("事件")}
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
  onBack,
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
  onBack: () => void;
  timeType: SecurityTimeType;
}) {
  const { t } = useI18n();
  if (!alert) {
    return (
      <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
        <div className="flex min-h-[360px] items-center justify-center text-sm text-zinc-500">{t("选择一个告警查看处置详情")}</div>
      </section>
    );
  }

  const labelRows = Object.entries(alert.labels ?? {}).filter(([, value]) => value !== "");
  const labelEvidenceCount = Number(alert.labels?.eventCount);
  const evidenceEventCount = alert.evidenceEventCount ??
    (Number.isFinite(labelEvidenceCount) ? labelEvidenceCount : 0);

  return (
    <section className="rounded-[8px] border border-white/10 bg-[#111612]/92">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onBack}
            className="h-8 shrink-0 border border-white/10 bg-white/5 px-2.5 text-zinc-200 hover:bg-white/10"
          >
            <ArrowLeft className="size-3.5" />
            {t("返回队列")}
          </Button>
          <span className="mx-1 h-5 w-px shrink-0 bg-white/10" />
          <BellRing className="size-4 shrink-0 text-rose-200" />
          <h2 className="truncate text-sm font-semibold text-zinc-100">{alert.title}</h2>
        </div>
        <Pill className={toneByStatus(alert.status)}>{t(STATUS_LABEL[alert.status])}</Pill>
      </div>

      <div className="space-y-4 p-4">
        <div className={cn(
          "rounded-md border p-3",
          alert.severity === "critical" || alert.severity === "high"
            ? "border-rose-400/25 bg-rose-500/8"
            : "border-amber-400/20 bg-amber-500/5",
        )}>
          <div className="flex flex-wrap items-center gap-2">
            <Pill className={toneByKind(alert.kind)}>{KIND_LABEL[alert.kind]}</Pill>
            <Pill className={toneBySeverity(alert.severity)}>{t(SEVERITY_LABEL[alert.severity])}</Pill>
            <span className="text-xs text-zinc-500">{formatDate(alert.lastSeenAt)}</span>
          </div>
          <p className="mt-3 text-xs font-semibold text-zinc-200">{t("为什么需要处理")}</p>
          <p className="mt-1 text-sm leading-6 text-zinc-300">{alert.description}</p>
          {alert.labels?.recommendedAction ? (
            <div className="mt-3 border-t border-white/10 pt-3">
              <p className="text-xs font-semibold text-teal-100">{t("建议下一步")}</p>
              <p className="mt-1 text-xs leading-5 text-zinc-400">{alert.labels.recommendedAction}</p>
            </div>
          ) : null}
        </div>

        <div className="grid gap-3 rounded-md border border-white/10 bg-white/[0.02] p-3 sm:grid-cols-2 xl:grid-cols-3">
          <FieldValue label="Agent" value={alert.agentId} />
          <FieldValue label="Workspace" value={alert.workspacePath} />
          <FieldValue label="来源" value={alert.sourceId ?? alert.collectorId ?? KIND_LABEL[alert.kind]} />
          <FieldValue label="规则" value={alert.ruleId} />
          <FieldValue label="首次发现" value={formatDate(alert.firstSeenAt)} />
          <FieldValue label="最近发现" value={formatDate(alert.lastSeenAt)} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">{t("等级")}</p>
            <p className="mt-1 text-sm font-semibold text-zinc-100">{t(SEVERITY_LABEL[alert.severity])}</p>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">{t("关联证据事件")}</p>
            <p className="mt-1 font-mono text-2xl font-semibold text-zinc-100">{evidenceEventCount}</p>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">{t("状态更新")}</p>
            <p className="mt-1 font-mono text-2xl font-semibold text-zinc-100">{alert.occurrenceCount}</p>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-[11px] text-zinc-600">{t("通知")}</p>
            <p className="mt-1 truncate font-mono text-xs text-zinc-300">{formatDate(alert.lastNotificationAt)}</p>
          </div>
        </div>

        {labelRows.length ? (
          <details className="group rounded-md border border-white/10 bg-white/[0.02]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5">
              <span className="flex items-center gap-2">
              <TerminalSquare className="size-4 text-teal-200" />
                <span className="text-xs font-semibold text-zinc-300">{t("技术标签与原始字段")}</span>
              </span>
              <span className="text-[11px] text-zinc-600 group-open:hidden">{t("展开")}</span>
              <span className="hidden text-[11px] text-zinc-600 group-open:inline">{t("收起")}</span>
            </summary>
            <div className="grid gap-2 border-t border-white/10 p-3 sm:grid-cols-2">
              {labelRows.map(([key, value]) => <FieldValue key={key} label={key} value={value} />)}
              <FieldValue label="Alert ID" value={alert.alertId} />
              <FieldValue label="去重键" value={alert.dedupeKey} />
              <FieldValue label="Trace" value={alert.traceId} />
              <FieldValue label="Incident" value={alert.incidentId} />
              <FieldValue label="Event" value={alert.eventId} />
              <FieldValue label="节点" value={alert.nodeName} />
            </div>
          </details>
        ) : null}

        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px]">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-400">{t("负责人")}</span>
            <Input value={owner} onChange={(event) => onOwnerChange(event.target.value)} placeholder="operator / team" className="h-9 border-white/10 bg-white/5 text-xs" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-400">{t("备注")}</span>
            <Input value={note} onChange={(event) => onNoteChange(event.target.value)} placeholder={t("处置说明")} className="h-9 border-white/10 bg-white/5 text-xs" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-400">{t("静默分钟")}</span>
            <Input value={silenceMinutes} onChange={(event) => onSilenceMinutesChange(event.target.value.replace(/\D/g, "").slice(0, 5))} className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={saving} onClick={() => onStatus("acknowledged")} className="h-8 bg-amber-400 text-[#171004] hover:bg-amber-300">
            {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <UserCheck className="size-3.5" />}
            {t("确认")}
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => onStatus("resolved")} className="h-8 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            <CheckCircle2 className="size-3.5" />
            {t("解决")}
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => onStatus("silenced")} className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <Clock3 className="size-3.5" />
            {t("静默")}
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => onStatus("open")} className="h-8 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <RotateCcw className="size-3.5" />
            {t("重开")}
          </Button>
        </div>

        <EvidenceLinks alert={alert} timeType={timeType} />
      </div>
    </section>
  );
}

export default function AlertsPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [timeType, setTimeType] = useState<SecurityTimeType>((searchParams.get("timeType") as SecurityTimeType) || "last_3h");
  const [scope, setScope] = useState<AlertScope>(searchParams.get("scope") === "raw" ? "raw" : "agent");
  const [timeMode, setTimeMode] = useState<AlertTimeMode>(searchParams.get("timeMode") === "backlog" ? "backlog" : "window");
  const [status, setStatus] = useState<AlertStatusFilter>(
    (searchParams.get("status") as AlertStatusFilter) || "active",
  );
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
    timeMode,
    scope,
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
  }), [kind, queryText, routeAgentId, routeCollectorId, routeEventId, routeIncidentId, routeIssueId, routeObjectiveId, routeSourceId, routeTaskId, routeWorkspacePath, scope, selectedAlertId, severity, status, timeMode, timeType]);

  const { data, loading, refresh } = useRequest(() => securityCenterApi.alerts(query), {
    refreshDeps: [query],
    pollingInterval: 10000,
    pollingWhenHidden: false,
  });

  const selectedAlert = useMemo(() => {
    if (!selectedAlertId) return undefined;
    const items = data?.items ?? [];
    return items.find((item) => item.alertId === selectedAlertId);
  }, [data, selectedAlertId]);

  const queueSearchParams = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("alertId");
    next.set("timeType", timeType);
    next.set("timeMode", timeMode);
    next.set("scope", scope);
    next.set("status", status);
    next.set("severity", severity);
    next.set("kind", kind);
    if (queryText.trim()) {
      next.set("q", queryText.trim());
    } else {
      next.delete("q");
    }
    return next;
  };

  const selectAlert = (alert: AlertListItem) => {
    setSelectedAlertId(alert.alertId);
    setOwner(alert.owner ?? "");
    setNote(alert.note ?? "");
    const next = queueSearchParams();
    next.set("alertId", alert.alertId);
    setSearchParams(next);
  };

  const returnToQueue = () => {
    setSelectedAlertId("");
    setOwner("");
    setNote("");
    setSearchParams(queueSearchParams(), { replace: true });
  };

  const clearFilters = () => {
    setStatus("active");
    setSeverity("all");
    setKind("all");
    setQueryText("");
    setTimeMode("window");
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
      const remainsVisible =
        status === "all" ||
        status === updated.status ||
        (status === "active" && (updated.status === "open" || updated.status === "acknowledged"));
      if (remainsVisible) {
        setSelectedAlertId(updated.alertId);
        setOwner(updated.owner ?? "");
        setNote(updated.note ?? "");
      } else {
        returnToQueue();
      }
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const overviewNavItems = MONITORING_NAV_ITEMS.filter((item) =>
    ["overview", "scan", "risk", "stream"].includes(item.view),
  );
  const platformNavItems = MONITORING_NAV_ITEMS.filter((item) =>
    ["events", "workspace"].includes(item.view),
  );
  const governanceNavItems = MONITORING_NAV_ITEMS.filter((item) => item.view === "supplyChain");
  const renderMonitoringNavItem = (item: (typeof MONITORING_NAV_ITEMS)[number]) => {
    const Icon = item.icon;
    return (
      <Link
        key={item.view}
        to={`/?view=${item.view}`}
        className="flex w-full items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-[#b6bdcc] transition-colors hover:bg-[#151a23] hover:text-[#e8ecf3]"
      >
        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-[#818a9c]">
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-semibold leading-[1.45]">{t(item.label)}</span>
          <span className="mt-0.5 block text-[10.5px] leading-4 text-[#5b6373]">{t(item.description)}</span>
        </span>
      </Link>
    );
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-[#0a0d12] text-zinc-100">
      <aside className="hidden">
        <nav className="space-y-1" aria-label={t("安全监控模块")}>
          <p className="flex items-center gap-2 px-3 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]">
            <LayoutDashboard className="size-3.5" />
            {t("概览")}
          </p>
          {overviewNavItems.map(renderMonitoringNavItem)}
          <div
            aria-current="page"
            className="flex w-full items-start gap-2.5 rounded-md border border-transparent bg-[#1c222d] px-2.5 py-2 text-left text-[#e8ecf3] shadow-[inset_2px_0_0_#f97316]"
          >
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-[#f97316]">
              <BellRing className="size-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold leading-[1.45]">{t("告警")}</span>
              <span className="mt-0.5 block text-[10.5px] leading-4 text-[#818a9c]">{t("活跃告警与处置")}</span>
            </span>
          </div>

          <p className="mt-3 flex items-center gap-2 border-t border-[#232a37] px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]">
            <ServerCog className="size-3.5" />
            {t("平台监控")}
          </p>
          {platformNavItems.map(renderMonitoringNavItem)}

          <p className="mt-3 flex items-center gap-2 border-t border-[#232a37] px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]">
            <Wrench className="size-3.5" />
            {t("运维")}
          </p>
          <Link
            to="/maintenance"
            className="flex w-full items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-[#b6bdcc] transition-colors hover:bg-[#151a23] hover:text-[#e8ecf3]"
          >
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-[#818a9c]">
              <CalendarClock className="size-3.5" />
            </span>
            <span className="block text-xs font-semibold leading-[1.45]">{t("维护")}</span>
          </Link>
          <Link
            to="/admin/policy"
            className="flex w-full items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left text-[#b6bdcc] transition-colors hover:bg-[#151a23] hover:text-[#e8ecf3]"
          >
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-[#818a9c]">
              <SlidersHorizontal className="size-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold leading-[1.45]">{t("策略配置")}</span>
              <span className="mt-0.5 block text-[10.5px] leading-4 text-[#5b6373]">{t("L1 / L2 / L3 研判策略")}</span>
            </span>
          </Link>

          <p className="mt-3 flex items-center gap-2 border-t border-[#232a37] px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]">
            <ShieldAlert className="size-3.5" />
            {t("安全治理")}
          </p>
          {governanceNavItems.map(renderMonitoringNavItem)}

          <p className="mt-3 flex items-center gap-2 border-t border-[#232a37] px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]">
            <SlidersHorizontal className="size-3.5" />
            {t("管理")}
          </p>
          <AdminTokenControl navigation />
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-[#232a37] bg-[#0f131a] px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Button asChild variant="secondary" size="sm" className="h-9 shrink-0 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10 lg:hidden">
              <Link to="/">
                <ArrowLeft className="size-3.5" />
                {t("返回")}
              </Link>
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Siren className="size-5 shrink-0 text-rose-300" />
                <h1 className="truncate text-lg font-semibold tracking-normal text-zinc-50">{t("告警中心")}</h1>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-500">Incident · Agent · L2/L3 · Collector · Source · Governance</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <div className="lg:hidden">
              <AdminTokenControl compact />
            </div>
            <span className={cn("rounded-full border px-2 py-0.5", data?.webhookConfigured ? "border-teal-400/25 bg-teal-500/10 text-teal-100" : "border-white/10 bg-white/5")}>
              Webhook {data?.webhookConfigured ? "on" : "off"}
            </span>
            <AlertScopeTabs value={scope} onChange={setScope} />
            <AlertTimeModeTabs
              value={timeMode}
              onChange={(next) => {
                setTimeMode(next);
                setSelectedAlertId("");
              }}
            />
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[120px_130px_130px_130px_minmax(180px,1fr)_auto_auto]">
          <Select value={timeType} disabled={timeMode === "backlog"} onValueChange={(next) => setTimeType(next as SecurityTimeType)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{TIME_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{t(option.label)}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={status} onValueChange={(next) => setStatus(next as AlertStatusFilter)}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{STATUS_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{t(option.label)}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={severity} onValueChange={(next) => setSeverity(next as SecuritySeverity | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{SEVERITY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{t(option.label)}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={kind} onValueChange={(next) => setKind(next as AlertKind | "all")}>
            <SelectTrigger className="h-9 border-white/10 bg-white/5 text-xs text-zinc-100"><SelectValue /></SelectTrigger>
            <SelectContent>{KIND_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{t(option.label)}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="alert / agent / collector / source / owner / team / risk" className="h-9 border-white/10 bg-white/5 font-mono text-xs" />
          <Button type="button" variant="secondary" size="sm" onClick={clearFilters} className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10">
            <X className="size-3.5" />
            {t("清除")}
          </Button>
          <Button type="button" size="sm" onClick={refresh} disabled={loading} className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400">
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {t("刷新")}
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <MetricTile label="需要处理" value={data?.summary.activeAlerts ?? 0} tone="border-rose-400/25 bg-rose-500/10 text-rose-100" />
            <MetricTile label="待确认" value={data?.summary.openAlerts ?? 0} tone="border-orange-400/25 bg-orange-500/10 text-orange-100" />
            <MetricTile label="严重/高" value={data?.summary.urgentActiveAlerts ?? 0} tone="border-fuchsia-400/25 bg-fuchsia-500/10 text-fuchsia-100" />
            <MetricTile label="已确认" value={data?.summary.acknowledgedAlerts ?? 0} tone="border-amber-400/25 bg-amber-500/10 text-amber-100" />
            <MetricTile label="未分配" value={data?.summary.unassignedActiveAlerts ?? 0} tone="border-sky-400/25 bg-sky-500/10 text-sky-100" />
            <MetricTile label="研判异常" value={data?.summary.judgmentAlerts ?? 0} tone="border-white/10 bg-white/[0.03] text-zinc-100" />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(560px,1fr)_minmax(0,1.25fr)]">
            <section className="min-h-[620px] rounded-[8px] border border-white/10 bg-[#111612]/92">
              <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <BellRing className="size-4 text-rose-200" />
                  <h2 className="text-sm font-semibold text-zinc-100">
                    {t(status === "active" ? "待处理队列" : "告警记录")}
                  </h2>
                </div>
                <span className="text-xs text-zinc-500">{data ? `${data.total} ${t("条")}` : "--"}</span>
              </div>
              <div className="grid grid-cols-[86px_minmax(0,1fr)_92px_54px_66px] gap-3 border-b border-white/10 bg-white/[0.02] px-3 py-2 text-[10px] font-semibold text-zinc-600">
                <span>{t("最近")}</span>
                <span>{t("告警与影响对象")}</span>
                <span>{t("类型")}</span>
                <span>{t("等级")}</span>
                <span>{t("状态")}</span>
              </div>
              {loading && !data ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  {t("加载告警...")}
                </div>
              ) : (data?.items?.length ?? 0) === 0 ? (
                <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">{t("暂无告警")}</div>
              ) : (
                <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
                  {data?.items.map((alert) => (
                    <AlertRow
                      key={alert.alertId}
                      alert={alert}
                      active={alert.alertId === selectedAlertId}
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
                onBack={returnToQueue}
              />
              <details className="group rounded-[8px] border border-white/10 bg-[#111612]/92">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
                  <span className="flex items-center gap-2">
                    <ShieldAlert className="size-4 text-teal-200" />
                    <span className="text-sm font-semibold text-zinc-200">{t("告警规则说明")}</span>
                    <span className="text-xs text-zinc-600">{data?.rules?.length ?? 0}</span>
                  </span>
                  <span className="text-xs text-zinc-600 group-open:hidden">{t("展开")}</span>
                  <span className="hidden text-xs text-zinc-600 group-open:inline">{t("收起")}</span>
                </summary>
                <div className="grid gap-2 border-t border-white/10 p-4 lg:grid-cols-2">
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
              </details>
            </div>
          </div>
        </div>
      </main>
      </div>
    </div>
  );
}
