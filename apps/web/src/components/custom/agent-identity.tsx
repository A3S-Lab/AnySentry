import type {
  AgentClassification,
  AgentEventListItem,
  AgentInventoryItem,
  AgentLifecycleState,
  AgentWorkloadRef,
} from "@/lib/api/security-center";
import { formatSecurityDateTime } from "@/lib/date-time";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

export type AgentRuntimeKind = "kubernetes" | "docker" | "local" | "unknown";

export interface ResolvedAgentIdentity {
  name: string;
  classification: AgentClassification;
  classificationLabel: string;
  runtime: AgentRuntimeKind;
  runtimeLabel?: string;
  locationLabel?: string;
  detectedName?: string;
  rawAgentId: string;
  workload?: AgentWorkloadRef;
}

const GENERIC_DISCOVERY_NAMES = new Set([
  "discovered agent candidate",
  "agent candidate",
  "unknown",
  "unknown agent",
]);

const CLASSIFICATION_META: Record<
  AgentClassification,
  { label: string; nameClassName: string; dotClassName: string; badgeClassName: string }
> = {
  confirmed_agent: {
    label: "已确认 Agent",
    nameClassName: "text-emerald-200",
    dotClassName: "bg-emerald-300",
    badgeClassName: "border-emerald-400/30 bg-emerald-500/10 text-emerald-100",
  },
  probable_agent: {
    label: "候选 Agent",
    nameClassName: "text-amber-200",
    dotClassName: "bg-amber-300",
    badgeClassName: "border-amber-400/30 bg-amber-500/10 text-amber-100",
  },
  unknown: {
    label: "身份未确认",
    nameClassName: "text-zinc-300",
    dotClassName: "bg-zinc-500",
    badgeClassName: "border-white/10 bg-white/5 text-zinc-400",
  },
  non_agent: {
    label: "非 Agent",
    nameClassName: "text-slate-400",
    dotClassName: "bg-slate-500",
    badgeClassName: "border-slate-500/30 bg-slate-500/10 text-slate-300",
  },
};

const RUNTIME_META: Record<
  Exclude<AgentRuntimeKind, "unknown">,
  { label: string; className: string }
> = {
  kubernetes: {
    label: "K8s",
    className: "border-violet-400/30 bg-violet-500/10 text-violet-200",
  },
  docker: {
    label: "Docker",
    className: "border-sky-400/30 bg-sky-500/10 text-sky-200",
  },
  local: {
    label: "本地服务",
    className: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
  },
};

const LIFECYCLE_META: Record<
  AgentLifecycleState,
  { label: string; className: string }
> = {
  current: {
    label: "当前实例",
    className: "border-teal-400/30 bg-teal-500/10 text-teal-100",
  },
  historical: {
    label: "历史实例",
    className: "border-amber-400/25 bg-amber-500/10 text-amber-100",
  },
  terminated: {
    label: "已结束",
    className: "border-white/10 bg-white/5 text-zinc-400",
  },
};

function text(value?: string) {
  return value?.trim() ?? "";
}

function meaningfulName(value?: string) {
  const candidate = text(value);
  return candidate && !GENERIC_DISCOVERY_NAMES.has(candidate.toLowerCase())
    ? candidate
    : "";
}

function basename(value?: string) {
  const candidate = text(value);
  return candidate.split("/").filter(Boolean).at(-1) ?? candidate;
}

function shortWorkloadId(value?: string) {
  const candidate = text(value);
  if (!candidate) return "";
  const last = candidate.split(":").filter(Boolean).at(-1) ?? candidate;
  return last.length > 16 ? last.slice(0, 12) : last;
}

function runtimeKind(event: AgentEventListItem): AgentRuntimeKind {
  if (event.runtime === "kubernetes") return "kubernetes";
  if (event.runtime === "docker") return "docker";
  if (event.runtime === "host") return "local";
  const workload = event.attribution?.workloadRef;
  if (workload?.environment === "kubernetes") return "kubernetes";
  if (workload?.environment === "docker") return "docker";
  if (workload?.environment === "host") return "local";

  const source = event.attribution?.source;
  if (source === "kubernetes") return "kubernetes";
  if (source === "docker") return "docker";

  const physical = text(event.attribution?.physicalWorkloadId).toLowerCase();
  if (physical.startsWith("k8s:")) return "kubernetes";
  if (physical.startsWith("docker:")) return "docker";

  const cgroup = text(event.process?.cgroup).toLowerCase();
  if (cgroup.includes("kubepods")) return "kubernetes";
  if (/(?:docker|containerd|crio|libpod)/.test(cgroup)) return "docker";

  if (
    event.process ||
    ["process_graph", "cgroup", "systemd", "argv", "env", "workspace_hint", "process_signature"].includes(
      source ?? "",
    )
  ) {
    return "local";
  }
  return "unknown";
}

function workloadName(event: AgentEventListItem) {
  const attribution = event.attribution;
  const workload = attribution?.workloadRef;
  const configuredName = meaningfulName(event.displayName);
  if (configuredName) return configuredName;
  const detectedName = meaningfulName(event.detectedName);
  if (detectedName) return detectedName;
  const displayName = meaningfulName(attribution?.agentDisplayName);
  if (displayName) return displayName;

  const structuredName =
    meaningfulName(workload?.podName) ||
    meaningfulName(workload?.containerName) ||
    meaningfulName(workload?.systemdUnit) ||
    meaningfulName(workload?.name) ||
    meaningfulName(workload?.processName) ||
    basename(workload?.executable);
  if (structuredName) return structuredName;

  const rawAgentName = meaningfulName(event.agentId);
  if (rawAgentName) return rawAgentName;

  const scopeName = meaningfulName(attribution?.agentScopeId);
  if (scopeName && !scopeName.startsWith("discovered-")) return scopeName;

  const workloadId = shortWorkloadId(attribution?.physicalWorkloadId);
  if (workloadId) return `workload-${workloadId}`;

  return scopeName || "未知 Agent";
}

export function resolveAgentIdentity(event: AgentEventListItem): ResolvedAgentIdentity {
  const classification =
    event.effectiveClassification ??
    event.attribution?.classification ??
    (event.attribution?.monitored ? "probable_agent" : "unknown");
  const runtime = runtimeKind(event);
  return {
    name: workloadName(event),
    classification,
    classificationLabel: CLASSIFICATION_META[classification].label,
    runtime,
    runtimeLabel: runtime === "unknown" ? undefined : RUNTIME_META[runtime].label,
    locationLabel: event.locationLabel,
    detectedName: event.detectedName ?? event.attribution?.agentDisplayName,
    rawAgentId: event.agentId,
    workload: event.attribution?.workloadRef,
  };
}

export function AgentIdentityInline({
  event,
  showClassification = false,
  showLocation = true,
  className,
}: {
  event: AgentEventListItem;
  showClassification?: boolean;
  showLocation?: boolean;
  className?: string;
}) {
  const { locale, t } = useI18n();
  const identity = resolveAgentIdentity(event);
  const identityName = t(identity.name);
  const classification = CLASSIFICATION_META[identity.classification];
  const runtime = identity.runtime === "unknown" ? undefined : RUNTIME_META[identity.runtime];
  const title = [
    identityName,
    t(identity.classificationLabel),
    runtime?.label ? t(runtime.label) : undefined,
    identity.locationLabel,
    identity.detectedName && identity.detectedName !== identity.name ? `${t("采集时")}：${identity.detectedName}` : undefined,
    identity.rawAgentId !== identity.name ? `${t("原始")}：${identity.rawAgentId}` : undefined,
    event.attribution?.source ? `${t("来源")}：${event.attribution.source}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span className={cn("inline-flex min-w-0 max-w-full flex-col gap-0.5", className)} title={title}>
      <span className="flex min-w-0 max-w-full items-center gap-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", classification.dotClassName)} />
        <span className={cn("min-w-0 truncate font-semibold", classification.nameClassName)}>
          {identityName}
          <span className="sr-only">{locale === "en" ? ` (${t(identity.classificationLabel)})` : `（${t(identity.classificationLabel)}）`}</span>
        </span>
        {showClassification ? (
          <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", classification.badgeClassName)}>
            {t(identity.classificationLabel)}
          </span>
        ) : null}
        {runtime ? (
          <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", runtime.className)}>
            {t(runtime.label)}
          </span>
        ) : null}
      </span>
      {showLocation && identity.locationLabel ? (
        <span className="ml-3 block max-w-full truncate font-mono text-[10px] font-normal text-zinc-600" title={identity.locationLabel}>
          {identity.locationLabel}
        </span>
      ) : null}
    </span>
  );
}

function assetRuntime(agent: AgentInventoryItem): AgentRuntimeKind {
  if (agent.runtime === "kubernetes") return "kubernetes";
  if (agent.runtime === "docker") return "docker";
  if (agent.runtime === "host") return "local";
  return "unknown";
}

export function AgentAssetIdentityInline({
  agent,
  showClassification = false,
  className,
}: {
  agent: AgentInventoryItem;
  showClassification?: boolean;
  className?: string;
}) {
  const classification = CLASSIFICATION_META[agent.classification];
  const runtimeKind = assetRuntime(agent);
  const runtime = runtimeKind === "unknown" ? undefined : RUNTIME_META[runtimeKind];
  const lifecycle = LIFECYCLE_META[agent.lifecycleState];
  const name =
    meaningfulName(agent.displayName) ||
    meaningfulName(agent.detectedName) ||
    meaningfulName(agent.workloadRef?.podName) ||
    meaningfulName(agent.workloadRef?.containerName) ||
    meaningfulName(agent.workloadRef?.processName) ||
    meaningfulName(agent.agentId) ||
    "候选 Agent";
  const location = agent.locationLabel || shortWorkspaceLabel(agent.workspacePath);
  const observedAt = formatSecurityDateTime(agent.firstSeen, "MM-DD HH:mm:ss");
  const instanceShortId =
    agent.rootPid
      ? `PID ${agent.rootPid}`
      : shortWorkloadId(agent.agentInstanceId) || agent.agentAssetId.replace(/^agent_/, "").slice(-6);
  const title = [
    name,
    `实例：${observedAt} · ${instanceShortId}`,
    lifecycle.label,
    CLASSIFICATION_META[agent.classification].label,
    runtime?.label,
    location,
    agent.detectedName && agent.detectedName !== name ? `采集时：${agent.detectedName}` : undefined,
    `资产：${agent.agentAssetId}`,
  ].filter(Boolean).join(" · ");
  return (
    <span className={cn("inline-flex min-w-0 max-w-full flex-col gap-0.5", className)} title={title}>
      <span className="flex min-w-0 max-w-full items-center gap-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", classification.dotClassName)} />
        <span className={cn("min-w-0 truncate font-semibold", classification.nameClassName)}>
          {name}
          <span className="ml-1 font-mono text-[10px] font-normal text-zinc-500">· {observedAt}</span>
        </span>
        <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", lifecycle.className)}>
          {lifecycle.label}
        </span>
        {showClassification ? (
          <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", classification.badgeClassName)}>
            {classification.label}
          </span>
        ) : null}
        {runtime ? (
          <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold", runtime.className)}>
            {runtime.label}
          </span>
        ) : null}
      </span>
      {location ? (
        <span className="ml-3 block max-w-full truncate font-mono text-[10px] font-normal text-zinc-600" title={agent.workspacePath}>
          {location} · {instanceShortId}
          {(agent.logicalInstanceCount ?? agent.instanceCount) > 1
            ? ` · 同逻辑 Agent ${(agent.logicalInstanceCount ?? agent.instanceCount)} 个实例`
            : ""}
        </span>
      ) : null}
    </span>
  );
}

function shortWorkspaceLabel(value?: string) {
  const parts = text(value).replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}
