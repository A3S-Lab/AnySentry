import { Activity, Braces, Check, Copy, FileJson, LoaderCircle, ShieldAlert, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import type {
  AgentInteractionRecord,
  AgentSemanticEvent,
  AgentSemanticEvidenceResponse,
} from "@/lib/api/security-center";
import { cn } from "@/lib/utils";
import { formatTokenCount } from "./agentUsage";

function safeJson(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function browserPreview(value: string, max = 200_000) {
  return value.length > max
    ? `${value.slice(0, max)}\n\n[浏览器预览已在 ${max.toLocaleString()} 字符处折叠；复制仍使用完整内容]`
    : value;
}

function nsDate(value?: string) {
  if (!value || !/^\d+$/u.test(value)) return "--";
  try {
    return new Date(Number(BigInt(value) / 1_000_000n)).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "--";
  }
}

function tone(event: AgentSemanticEvent) {
  if (event.actor === "user") return "border-sky-400/20 bg-sky-500/[0.06] text-sky-100";
  if (event.actor === "model") return "border-teal-400/20 bg-teal-500/[0.06] text-teal-100";
  return "border-violet-400/20 bg-violet-500/[0.06] text-violet-100";
}

function actorTitle(event: AgentSemanticEvent) {
  if (event.actor === "user") return "用户 · 人工输入";
  if (event.actor === "model") return `模型 · ${event.kind === "model_final" ? "最终回复" : "过程说明"}`;
  return `工具 · ${event.toolName ?? event.toolKind ?? "Tool"}`;
}

function CopyAction({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <Button type="button" variant="ghost" size="sm" onClick={() => void copy()} className="h-9 text-zinc-400 hover:bg-white/5 hover:text-zinc-100" aria-label={label}>
      {copied ? <Check className="size-3.5 text-teal-300" /> : <Copy className="size-3.5" />}
      {copied ? "已复制" : "复制"}
    </Button>
  );
}

function EvidenceField({ label, value }: { label: string; value?: ReactNode }) {
  return (
    <div className="min-w-0 border-b border-white/8 py-2 last:border-b-0">
      <dt className="text-[10px] uppercase tracking-[0.08em] text-zinc-600">{label}</dt>
      <dd className="mt-1 break-all font-mono text-[11px] leading-5 text-zinc-300">{value ?? "--"}</dd>
    </div>
  );
}

function eventHref(
  eventId: string,
  interaction?: AgentInteractionRecord,
  eventAt?: string,
  semantic?: Pick<AgentSemanticEvent, "conversationId" | "semanticEventId">,
) {
  const at = eventAt ? Date.parse(eventAt) : Number.NaN;
  const params = new URLSearchParams({ scope: "agent", eventId });
  if (Number.isFinite(at)) {
    params.set("timeType", "custom");
    params.set("startTime", new Date(Math.max(0, at - 5_000)).toISOString());
    params.set("endTime", new Date(at + 5_000).toISOString());
    params.set("snapshotAsOf", new Date(at + 5_000).toISOString());
  } else {
    params.set("timeType", "last_30d");
  }
  if (semantic) {
    params.set("conversationId", semantic.conversationId);
    params.set("semanticEventId", semantic.semanticEventId);
  }
  if (interaction?.agentAssetId) params.set("agentAssetId", interaction.agentAssetId);
  if (interaction?.agentInstanceId) params.set("agentInstanceId", interaction.agentInstanceId);
  return "/events?" + params.toString();
}

function KernelEvidenceView({
  event,
  interaction,
  evidence,
  loading,
}: {
  event: AgentSemanticEvent;
  interaction?: AgentInteractionRecord;
  evidence?: AgentSemanticEvidenceResponse;
  loading: boolean;
}) {
  if (loading && !evidence) {
    return <div className="flex min-h-40 items-center justify-center gap-2 text-xs text-zinc-500"><LoaderCircle className="size-4 animate-spin" />正在关联内核事实</div>;
  }
  return (
    <div className="space-y-3">
      <dl className="rounded border border-white/8 bg-black/15 px-3">
        <EvidenceField label="Relation Status" value={evidence?.relationStatus ?? (event.actor === "tool" ? "semantic_only" : "not_applicable")} />
        <EvidenceField label="Tool Invocation" value={evidence?.toolInvocationId} />
        <EvidenceField label="Interaction Event" value={(evidence?.interactionEvidenceEventIds ?? event.evidenceEventIds).join(", ")} />
        <EvidenceField label="Agent Instance" value={interaction?.agentInstanceId} />
        <EvidenceField label="Correlation" value={event.correlationQuality} />
      </dl>
      {evidence?.relations.some((relation) => relation.kernelEventId) ? (
        <div className="divide-y divide-white/8 rounded border border-white/8 bg-black/15">
          {evidence.relations.filter((relation) => relation.kernelEventId).map((relation) => {
            const kernel = evidence.kernelEvents.find((item) => item.eventId === relation.kernelEventId);
            return (
              <div key={relation.relationId} className="px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded border border-teal-400/20 bg-teal-500/[0.07] px-1.5 py-1 text-[10px] text-teal-100">{relation.status}</span>
                  <span className="rounded border border-white/10 px-1.5 py-1 font-mono text-[10px] text-zinc-400">{relation.linkMethod}</span>
                  <span className="font-mono text-[10px] text-zinc-600">confidence {relation.confidence.toFixed(2)}</span>
                </div>
                <p className="mt-2 text-xs leading-5 text-zinc-300">{kernel?.eventKind ?? "Kernel Event"} · {kernel?.subject ?? relation.kernelEventId}</p>
                <Link className="mt-2 inline-flex min-h-9 items-center text-xs font-medium text-teal-200 hover:text-teal-100" to={eventHref(relation.kernelEventId!, interaction, kernel?.at ?? relation.kernelEventAt, event)}>
                  查看原始内核事件
                </Link>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded border border-amber-400/15 bg-amber-500/[0.035] px-3 py-3 text-xs leading-5 text-amber-100/75">
          {evidence?.relationStatus === "coverage_gap"
            ? "当前内核采集窗口不完整，保留语义工具事实但不猜测执行事件。"
            : "已确认工具语义，但没有满足运行实例、进程祖先和命令、资源或网络强条件的内核事件。"}
        </div>
      )}
    </div>
  );
}

function RiskEvidenceView({
  interaction,
  evidence,
  loading,
}: {
  interaction?: AgentInteractionRecord;
  evidence?: AgentSemanticEvidenceResponse;
  loading: boolean;
}) {
  if (loading && !evidence) {
    return <div className="flex min-h-40 items-center justify-center gap-2 text-xs text-zinc-500"><LoaderCircle className="size-4 animate-spin" />正在读取既有风险研判</div>;
  }
  const risky = evidence?.relations.filter((relation) => relation.kernelEventId && relation.risk) ?? [];
  if (!risky.length) {
    return (
      <div className="rounded border border-white/8 bg-black/15 px-4 py-8 text-center text-xs leading-5 text-zinc-500">
        当前没有已关联的 Kernel Judgment。页面不会根据工具文字重新生成一套风险分数。
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {risky.map((relation) => (
        <div key={relation.relationId} className="rounded border border-white/8 bg-black/15 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn(
              "rounded border px-1.5 py-1 text-[10px]",
              relation.risk!.verdict === "allow"
                ? "border-teal-400/20 bg-teal-500/[0.07] text-teal-100"
                : "border-rose-400/25 bg-rose-500/[0.08] text-rose-100",
            )}>{relation.risk!.verdict}</span>
            <span className="font-mono text-xs font-semibold text-zinc-100">风险 {relation.risk!.riskScore}</span>
            <span className="text-[10px] text-zinc-500">{relation.risk!.tier} · {relation.risk!.severity}</span>
          </div>
          <p className="mt-2 text-xs font-medium text-zinc-200">{relation.risk!.riskName}</p>
          <p className="mt-1 text-[11px] leading-5 text-zinc-500">{relation.risk!.reason}</p>
          <Link className="mt-2 inline-flex min-h-9 items-center text-xs font-medium text-violet-200 hover:text-violet-100" to={eventHref(relation.kernelEventId!, interaction, relation.kernelEventAt, {
            conversationId: relation.conversationId,
            semanticEventId: relation.stableSemanticEventId,
          })}>
            打开风险事件与 Evidence Bundle
          </Link>
        </div>
      ))}
    </div>
  );
}

export function SemanticInteractionInspector({
  event,
  interaction,
  loading,
  semanticEvidence,
  evidenceLoading,
  onClose,
}: {
  event?: AgentSemanticEvent;
  interaction?: AgentInteractionRecord;
  loading: boolean;
  semanticEvidence?: AgentSemanticEvidenceResponse;
  evidenceLoading: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"content" | "kernel" | "risk" | "raw">("content");
  useEffect(() => setTab("content"), [event?.semanticEventId]);
  const structured = useMemo(() => event ? safeJson(event.content ?? event.contentPreview) : "", [event]);
  const tabs = [
    ["content", "内容", Braces],
    ["kernel", "内核证据", Activity],
    ["risk", "风险研判", ShieldAlert],
    ["raw", "原始", FileJson],
  ] as const;
  const moveTab = (keyboardEvent: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (keyboardEvent.key !== "ArrowLeft" && keyboardEvent.key !== "ArrowRight") return;
    keyboardEvent.preventDefault();
    const next = (index + (keyboardEvent.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    setTab(tabs[next][0]);
    const tabList = keyboardEvent.currentTarget.parentElement;
    window.requestAnimationFrame(() => (tabList?.children[next] as HTMLElement | undefined)?.focus());
  };

  if (!event) {
    return (
      <aside className="hidden h-full min-h-0 border-l border-white/10 bg-[#0d120f] xl:flex xl:items-center xl:justify-center" aria-label="事件检查器">
        <div className="px-6 text-center">
          <FileJson className="mx-auto size-7 text-zinc-700" aria-hidden="true" />
          <p className="mt-3 text-xs leading-5 text-zinc-500">选择一条用户、模型或工具事件，查看结构化内容、原始正文和采集证据。</p>
        </div>
      </aside>
    );
  }

  return (
    <>
      <button type="button" aria-label="关闭事件检查器" onClick={onClose} className="fixed inset-0 z-40 cursor-default bg-black/60 xl:hidden" />
      <aside className="fixed inset-x-3 bottom-3 top-20 z-50 min-h-0 overflow-hidden rounded-md border border-white/15 bg-[#0d120f] shadow-2xl xl:static xl:z-auto xl:h-full xl:rounded-none xl:border-y-0 xl:border-r-0 xl:shadow-none" aria-label="事件检查器">
        <div className="flex h-14 items-center gap-2 border-b border-white/10 px-3">
          <FileJson className="size-4 shrink-0 text-violet-300" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xs font-semibold text-zinc-100">{actorTitle(event)}</h2>
            <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">{event.semanticEventId}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="关闭事件检查器" className="size-11 text-zinc-400 hover:bg-white/5 hover:text-zinc-100 xl:size-9">
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex h-11 items-center border-b border-white/10 px-2" role="tablist" aria-label="检查器视图">
          {tabs.map(([value, label, Icon], index) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              onKeyDown={(keyboardEvent) => moveTab(keyboardEvent, index)}
              onClick={() => setTab(value)}
              className={cn(
                "flex h-11 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1 border-b whitespace-nowrap text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70 sm:gap-1.5 sm:text-xs",
                tab === value ? "border-violet-300 text-violet-100" : "border-transparent text-zinc-500 hover:text-zinc-200",
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />{label}
            </button>
          ))}
        </div>

        <div className="h-[calc(100%-6.25rem)] overflow-y-auto p-3">
          {loading && !interaction && (tab === "content" || tab === "raw") ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-xs text-zinc-500"><LoaderCircle className="size-4 animate-spin" />正在读取完整 Interaction</div>
          ) : tab === "content" ? (
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  <span className={cn("rounded border px-1.5 py-1 text-[10px]", tone(event))}>{actorTitle(event)}</span>
                  <span className="rounded border border-white/10 bg-white/[0.035] px-1.5 py-1 text-[10px] text-zinc-400">{event.completeness}</span>
                </div>
                {structured ? <CopyAction value={structured} label="复制结构化内容" /> : null}
              </div>
              <pre className="max-h-[calc(100dvh-14rem)] overflow-auto whitespace-pre-wrap break-words rounded border border-white/8 bg-black/20 p-3 font-mono text-[11px] leading-5 text-zinc-300">{browserPreview(structured || "该事件没有结构化正文。")}</pre>
              {interaction?.interactionType === "model" ? (
                interaction.usage ? (
                  <dl className="mt-3 grid grid-cols-2 rounded border border-teal-400/15 bg-teal-500/[0.035] sm:grid-cols-3">
                    {[
                      ["总 Token", interaction.usage.totalTokens],
                      ["输入", interaction.usage.inputTokens],
                      ["输出", interaction.usage.outputTokens],
                      ["缓存输入", interaction.usage.cachedInputTokens],
                      ["推理输出", interaction.usage.reasoningOutputTokens],
                      ["覆盖", interaction.usage.completeness],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="border-b border-r border-white/8 px-3 py-2 last:border-r-0">
                        <dt className="text-[9px] uppercase tracking-[0.08em] text-zinc-600">{String(label)}</dt>
                        <dd className="mt-1 font-mono text-[11px] text-zinc-300">
                          {typeof value === "number" ? formatTokenCount(value, false) : value ?? "--"}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="mt-3 rounded border border-white/8 bg-black/15 px-3 py-2 text-[11px] text-zinc-500">
                    本次模型调用没有返回可核验的 Token usage；页面不会用文本长度估算。
                  </p>
                )
              ) : null}
              {event.kind === "tool_result" ? <p className="mt-3 text-[11px] leading-5 text-zinc-500">工具结果时间表示该结果重新进入模型请求的明文边界；框架内部精确结束时间仅在有独立工具传输证据时展示。</p> : null}
            </div>
          ) : tab === "kernel" ? (
            <KernelEvidenceView event={event} interaction={interaction} evidence={semanticEvidence} loading={evidenceLoading} />
          ) : tab === "risk" ? (
            <RiskEvidenceView interaction={interaction} evidence={semanticEvidence} loading={evidenceLoading} />
          ) : tab === "raw" ? (
            <div className="space-y-3">
              {!interaction ? <p className="py-12 text-center text-xs text-zinc-500">该事件没有关联的原始 Interaction。</p> : (
                <>
                  {[["最终发送给 LLM / 工具的请求", interaction.request, "请求"], ["LLM / 工具返回给 Agent 的响应", interaction.response, "响应"]].map(([title, content, label]) => {
                    const side = content as AgentInteractionRecord["request"];
                    return (
                      <details key={String(title)} open className="rounded border border-white/8 bg-black/15">
                        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-zinc-200">{String(title)}</summary>
                        <div className="border-t border-white/8 p-3">
                          <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500"><span>{side.contentType}</span><span>{side.decodedBytes.toLocaleString()} bytes</span><span>{side.completeness}</span><CopyAction value={side.body} label={`复制完整${label}正文`} /></div>
                          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-3 font-mono text-[11px] leading-5 text-zinc-300">{browserPreview(side.body)}</pre>
                        </div>
                      </details>
                    );
                  })}
                </>
              )}
            </div>
          ) : (
            <dl className="rounded border border-white/8 bg-black/15 px-3">
              <EvidenceField label="Conversation / Segment" value={`${event.conversationId} · ${event.segmentId}`} />
              <EvidenceField label="Turn" value={event.turnId} />
              <EvidenceField label="Semantic Event" value={event.semanticEventId} />
              <EvidenceField label="Interaction" value={event.sourceInteractionIds.join(", ")} />
              <EvidenceField label="Agent Asset" value={interaction?.agentAssetId} />
              <EvidenceField label="Agent Instance" value={interaction?.agentInstanceId} />
              <EvidenceField label="Process" value={interaction?.process ? `pid ${interaction.process.pid} · ${interaction.process.comm ?? "--"}` : undefined} />
              <EvidenceField label="Transport" value={interaction ? `${interaction.transport} · ${interaction.protocol} · ${interaction.captureSource}` : undefined} />
              <EvidenceField label="TLS Adapter" value={interaction?.tlsAdapterId} />
              <EvidenceField label="Wire Template" value={interaction?.wireTemplateId ?? interaction?.parseState} />
              <EvidenceField label="Parser" value={`${event.parserId} · v${event.parserVersion}`} />
              <EvidenceField label="Observed At" value={nsDate(event.atUnixNs)} />
              <EvidenceField label="Completeness" value={`${event.completeness}${event.partialReasons.length ? ` · ${event.partialReasons.join(", ")}` : ""}`} />
              <EvidenceField label="Request SHA-256" value={interaction?.request.sha256} />
              <EvidenceField label="Response SHA-256" value={interaction?.response.sha256} />
              <EvidenceField label="Correlation" value={event.correlationQuality} />
              {interaction ? (
                <EvidenceField label="下钻" value={<Link className="font-sans text-violet-200 hover:text-violet-100" to={`/events?${new URLSearchParams({ timeType: "last_30d", agentAssetId: interaction.agentAssetId, agentInstanceId: interaction.agentInstanceId ?? "", scope: "agent" }).toString()}`}>查看 Agent 原始行为与 Egress</Link>} />
              ) : null}
            </dl>
          )}
        </div>
      </aside>
    </>
  );
}
