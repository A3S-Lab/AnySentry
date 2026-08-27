import { useId, useState, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  FlaskConical,
  History,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Network,
  PlayCircle,
  Plus,
  SearchCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type {
  CaptureProbeAction,
  FilterRuleDetail,
  FilterRulePreview,
  FilterRuleSimulation,
} from "@/lib/api/filter-rules";

type DetailTab = "overview" | "matcher" | "stages" | "materialization" | "history";
export type FilterRuleSimulationWindow = "current" | "last_30m" | "last_3h" | "last_24h";
const TABS: Array<{ id: DetailTab; label: string; icon: typeof Layers3 }> = [
  { id: "overview", label: "概要", icon: Layers3 },
  { id: "matcher", label: "匹配条件", icon: SearchCheck },
  { id: "stages", label: "阶段影响", icon: Network },
  { id: "materialization", label: "当前物化", icon: PlayCircle },
  { id: "history", label: "Revision 与审计", icon: History },
];

function lifecycleTone(stage: FilterRuleDetail["lifecycleStage"]) {
  if (stage === "enforced") return "border-emerald-400/25 bg-emerald-500/10 text-emerald-100";
  if (stage === "shadow") return "border-amber-400/25 bg-amber-500/10 text-amber-100";
  if (stage === "revoked") return "border-slate-500/30 bg-slate-500/10 text-slate-300";
  return "border-sky-400/25 bg-sky-500/10 text-sky-100";
}

function actionTone(action: CaptureProbeAction) {
  if (action === "full") return "text-emerald-200";
  if (action === "aggregate") return "text-cyan-200";
  if (action === "sample") return "text-amber-200";
  if (action === "not_enabled") return "text-slate-400";
  return "text-rose-200";
}

function date(value?: string | number) {
  const parsed = value ? new Date(value) : undefined;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : "--";
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0 bg-[#141a23] px-3 py-2.5">
      <p className="text-[10px] text-[#788294]">{t(label)}</p>
      <p className={cn("mt-1 break-words text-sm font-semibold text-[#e7ebf2] [overflow-wrap:anywhere]", tone)}>{value}</p>
    </div>
  );
}

export function FilterRuleDetailPanel({
  rule,
  preview,
  simulation,
  reason,
  actionLoading,
  onReasonChange,
  onPreview,
  onSimulate,
  onShadow,
  onPromote,
  onRevoke,
  onCreateSuccessor,
  simulationWindow,
  onSimulationWindowChange,
}: {
  rule: FilterRuleDetail;
  preview?: FilterRulePreview;
  simulation?: FilterRuleSimulation;
  reason: string;
  actionLoading: boolean;
  onReasonChange: (reason: string) => void;
  onPreview: () => void;
  onSimulate: () => void;
  onShadow: () => void;
  onPromote: () => void;
  onRevoke: () => void;
  onCreateSuccessor?: () => void;
  simulationWindow: FilterRuleSimulationWindow;
  onSimulationWindowChange: (window: FilterRuleSimulationWindow) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<DetailTab>("overview");
  const reasonId = useId();
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = TABS.findIndex((item) => item.id === tab);
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    setTab(TABS[next].id);
    document.getElementById(`filter-rule-tab-${TABS[next].id}`)?.focus();
  };

  return (
    <div className="min-w-0">
      <header className="border-b border-[#27303d] px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("inline-flex rounded border px-2 py-0.5 text-[10px] font-semibold", lifecycleTone(rule.lifecycleStage))}>{t(rule.lifecycleStage)}</span>
          <span className="rounded border border-[#303a49] bg-[#151b24] px-2 py-0.5 text-[10px] text-[#9ba5b5]">{t(rule.categoryLabel)}</span>
          <span className="font-mono text-[10px] text-[#697386]">r{rule.revision}</span>
          {!rule.editable ? <span className="inline-flex items-center gap-1 text-[10px] text-[#778194]"><LockKeyhole className="size-3" aria-hidden="true" />{t("只读规则")}</span> : null}
        </div>
        <h2 className="mt-2 break-words text-lg font-semibold text-[#f0f3f8] [overflow-wrap:anywhere]">{rule.name}</h2>
        <p className="mt-1 max-w-4xl text-xs leading-5 text-[#929cad]">{rule.description}</p>
        <p className="mt-2 font-mono text-[10px] text-[#5f6979]">{rule.ruleId}</p>
      </header>

      <div role="tablist" aria-label={t("规则详情视图")} onKeyDown={onTabKeyDown} className="flex min-h-12 overflow-x-auto border-b border-[#27303d] bg-[#10151d] px-2">
        {TABS.map((item) => {
          const Icon = item.icon;
          const selected = tab === item.id;
          return (
            <button
              key={item.id}
              id={`filter-rule-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`filter-rule-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(item.id)}
              className={cn(
                "relative flex min-h-11 shrink-0 items-center gap-1.5 px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f97316]",
                selected ? "text-[#f4f6fa] after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-[#f97316]" : "text-[#7f899b] hover:text-[#cbd2dd]",
              )}
            ><Icon className="size-3.5" aria-hidden="true" />{t(item.label)}</button>
          );
        })}
      </div>

      <div id={`filter-rule-panel-${tab}`} role="tabpanel" aria-labelledby={`filter-rule-tab-${tab}`} className="min-w-0">
        {tab === "overview" ? (
          <div>
            <section className="grid overflow-hidden border-b border-[#27303d] bg-[#2b3544] sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="规则类型" value={t(rule.kindLabel)} />
              <Metric label="来源" value={t(rule.sourceLabel)} />
              <Metric label="权限状态" value={t(rule.authority)} />
              <Metric label="优先级" value={rule.priority} />
              <Metric label="匹配资产" value={rule.matchedAssets} />
              <Metric label="匹配实例" value={rule.matchedInstances} />
              <Metric label="匹配节点" value={rule.matchedNodes} />
              <Metric label="冲突" value={rule.conflicts} tone={rule.conflicts ? "text-rose-200" : "text-emerald-200"} />
            </section>
            <section className="grid gap-0 border-b border-[#27303d] px-4 py-2 md:grid-cols-2 md:gap-x-6">
              {[
                ["自然语言匹配", rule.matcherText],
                ["产生结果", rule.effectText],
                ["Owner", rule.owner],
                ["创建人", rule.createdBy],
                ["批准人", rule.approvedBy ?? "--"],
                ["前序规则", rule.predecessorRuleId ?? "--"],
                ["更新时间", date(rule.updatedAt)],
                ["变更原因", rule.reason],
                ["管理方式", rule.management],
              ].map(([label, value]) => (
                <div key={label} className="border-b border-[#27303d] py-3 last:border-b-0">
                  <p className="text-[10px] text-[#778194]">{t(label)}</p>
                  {label === "前序规则" && rule.predecessorRuleId ? <Link to={`/filter-rules?ruleId=${encodeURIComponent(rule.predecessorRuleId)}`} className="mt-1 block break-words font-mono text-xs leading-5 text-cyan-300 underline-offset-2 hover:underline [overflow-wrap:anywhere]">{value}</Link> : <p className="mt-1 break-words text-xs leading-5 text-[#dce2eb] [overflow-wrap:anywhere]">{value}</p>}
                </div>
              ))}
            </section>
            {rule.ruleKind === "signal_enablement" ? (
              <section className="border-b border-[#27303d] px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold text-[#cbd2dd]">{t("选择性信号启用边界")}</p>
                    <p className="mt-1 text-[11px] leading-5 text-[#7f899b]">{t("这是统一规则在 F0/F1/F2/F3 的同一投影，不是独立的节点配置。")}</p>
                  </div>
                  <span className="rounded border border-slate-400/20 bg-slate-500/10 px-2 py-1 font-mono text-[10px] text-slate-300">
                    {`${rule.effect.signal ?? "file_open_read"} default=${rule.effect.defaultAction ?? "not_enabled"}`}
                  </span>
                </div>
                <div className="mt-3 grid overflow-hidden rounded border border-[#2b3544] bg-[#2b3544] sm:grid-cols-2 xl:grid-cols-4">
                  <Metric label="命中后动作" value={rule.effect.captureAction ?? "full"} tone="text-emerald-200" />
                  <Metric label="物化范围" value={rule.effect.scopeMode ?? "exact_runtime_or_root"} />
                  <Metric label="当前有效 Scope" value={rule.materialization.activeBindings} />
                  <Metric label="Reason Code" value={rule.effect.reasonCode ?? "agent_file_read_enabled"} />
                </div>
                <p className="mt-3 rounded border border-amber-400/15 bg-amber-500/[0.05] px-3 py-2 text-[11px] leading-5 text-amber-100/75">
                  {t("只有 probable/confirmed Agent 且 binding=exact 时启用；共享 cgroup 仅物化精确 Root。Scope stale、TTL 过期或 map miss 时关闭可选 read 并记录 coverage gap，不执行节点级全局 fail-open。")}
                </p>
                <div className="mt-3 overflow-hidden rounded border border-[#2b3544]">
                  {[
                    ["Host Agent Root", "probable + exact root", "启用 read"],
                    ["同 session 普通 shell", "不属于 Agent Root", "不启用"],
                    ["K8s 专用 Agent container", "confirmed + exact runtime", "启用 read"],
                    ["同 Pod sidecar", "不同 container/runtime", "不启用"],
                    ["候选 Agent 弱绑定", "probable + weak", "等待精确绑定"],
                    ["Scope TTL 已过期", "stale / map miss", "关闭并记录 gap"],
                  ].map(([subject, condition, outcome]) => (
                    <div key={subject} className="grid gap-1 border-b border-[#27303d] bg-[#141a23] px-3 py-2.5 last:border-b-0 sm:grid-cols-[minmax(130px,0.7fr)_minmax(150px,1fr)_minmax(120px,0.7fr)] sm:gap-3">
                      <span className="text-[11px] font-semibold text-[#dce2eb]">{t(subject)}</span>
                      <span className="font-mono text-[10px] text-[#7f899b]">{condition}</span>
                      <span className={cn("text-[11px]", outcome === "启用 read" ? "text-emerald-200" : "text-amber-200")}>{t(outcome)}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            {rule.effect.probeActions ? (
              <section className="border-b border-[#27303d] px-4 py-4">
                <p className="text-xs font-semibold text-[#cbd2dd]">{t("Probe 动作矩阵")}</p>
                <div className="mt-2 grid overflow-hidden rounded border border-[#2b3544] bg-[#2b3544] sm:grid-cols-2 xl:grid-cols-5">
                  {Object.entries(rule.effect.probeActions).map(([probe, action]) => (
                    <div key={probe} className="bg-[#141a23] px-3 py-2.5">
                      <p className="font-mono text-[10px] text-[#788294]">{probe}</p>
                      <p className={cn("mt-1 text-xs font-semibold uppercase", actionTone(action))}>{action}</p>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}

        {tab === "matcher" ? (
          <section className="px-4 py-4">
            <p className="text-xs font-semibold text-[#cbd2dd]">{t("服务端 Typed Matcher")}</p>
            <p className="mt-1 text-[11px] leading-5 text-[#7f899b]">{rule.matcher.description}</p>
            <div className="mt-3 overflow-hidden rounded border border-[#2b3544]">
              {rule.matcher.conditions.length ? rule.matcher.conditions.map((condition, index) => (
                <div key={`${condition.field}:${index}`} className="grid gap-2 border-b border-[#27303d] bg-[#141a23] px-3 py-3 last:border-b-0 sm:grid-cols-[minmax(150px,0.8fr)_110px_minmax(0,1.4fr)]">
                  <span className="break-all font-mono text-[11px] text-cyan-200">{condition.field}</span>
                  <span className="font-mono text-[10px] uppercase text-[#8d97a9]">{condition.operator}</span>
                  <span className="break-words text-xs text-[#dce2eb] [overflow-wrap:anywhere]">{condition.value}</span>
                </div>
              )) : <p className="bg-[#141a23] px-3 py-4 text-xs text-[#7f899b]">{t("该规则没有可编辑的 Matcher 条件。")}</p>}
            </div>
          </section>
        ) : null}

        {tab === "stages" ? (
          <section className="px-4 py-4">
            <p className="text-xs font-semibold text-[#cbd2dd]">{t("F0/F1/F2/F3 编译影响")}</p>
            <div className="mt-3 grid gap-2 xl:grid-cols-4">
              {rule.stageImpacts.map((impact) => (
                <div key={impact.stage} className={cn(
                  "rounded border p-3",
                  impact.applicability === "active" ? "border-cyan-400/20 bg-cyan-500/5" : impact.applicability === "pending" ? "border-amber-400/20 bg-amber-500/5" : "border-[#2b3544] bg-[#141a23]",
                )}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-[#fb923c]">{impact.stage.toUpperCase()}</span>
                    <span className="text-[10px] text-[#8d97a9]">{t(impact.applicability)}</span>
                  </div>
                  <p className="mt-2 text-xs font-semibold leading-5 text-[#e1e6ee]">{impact.action}</p>
                  <p className="mt-1 text-[10px] leading-4 text-[#788294]">{impact.reason}</p>
                  <p className="mt-2 font-mono text-[9px] text-[#596373]">v{impact.version ?? "--"}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {tab === "materialization" ? (
          <section className="px-4 py-4">
            <p className="text-xs font-semibold text-[#cbd2dd]">{t("逻辑规则到物理实例")}</p>
            <p className="mt-1 text-[11px] leading-5 text-[#7f899b]">{t("页面展示安全汇总，不暴露原始 cgroup map、epoch 或 grant JSON。")}</p>
            <div className="mt-3 grid overflow-hidden rounded border border-[#2b3544] bg-[#2b3544] sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="节点回报" value={rule.materialization.reports} />
              <Metric label="已接受绑定" value={rule.materialization.acceptedBindings} />
              <Metric label="当前有效绑定" value={rule.materialization.activeBindings} />
              <Metric label="最近回报" value={date(rule.materialization.lastReportAt)} />
            </div>
            <div className="mt-3 rounded border border-[#2b3544] bg-[#141a23] p-3">
              <p className="text-[10px] text-[#778194]">{t("已回报节点")}</p>
              <p className="mt-1 break-words font-mono text-[11px] leading-5 text-[#dce2eb]">{rule.materialization.nodes.length ? rule.materialization.nodes.join(", ") : "--"}</p>
            </div>
          </section>
        ) : null}

        {tab === "history" ? (
          <section className="grid gap-4 px-4 py-4 xl:grid-cols-2">
            <div>
              <p className="text-xs font-semibold text-[#cbd2dd]">{t("Revision")}</p>
              <div className="mt-2 overflow-hidden rounded border border-[#2b3544]">
                {rule.revisions.map((revision) => (
                  <div key={revision.revision} className="flex min-h-12 items-center justify-between gap-3 border-b border-[#27303d] bg-[#141a23] px-3 last:border-b-0">
                    <span className="text-xs text-[#dce2eb]">r{revision.revision} · {t(revision.lifecycleStage)} · {t(revision.authority)}</span>
                    <span className="text-[10px] text-[#697386]">{date(revision.updatedAt)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-[#cbd2dd]">{t("操作审计")}</p>
              <div className="mt-2 overflow-hidden rounded border border-[#2b3544]">
                {rule.operations.length ? rule.operations.map((operation) => (
                  <div key={operation.operationId} className="border-b border-[#27303d] bg-[#141a23] px-3 py-2.5 last:border-b-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-[#dce2eb]">{operation.kind} · {operation.status}</span>
                      <span className="text-[10px] text-[#697386]">{date(operation.completedAt ?? operation.requestedAt)}</span>
                    </div>
                    <p className="mt-1 text-[10px] text-[#788294]">{operation.actorId}{operation.reason ? ` · ${operation.reason}` : ""}</p>
                  </div>
                )) : <p className="bg-[#141a23] px-3 py-4 text-xs text-[#7f899b]">{t("暂无操作记录")}</p>}
              </div>
            </div>
          </section>
        ) : null}
      </div>

      <section className="border-t border-[#27303d] px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-[#cbd2dd]">{t("规则治理")}</p>
            <p className="mt-1 max-w-2xl text-[11px] leading-5 text-[#7f899b]">
              {t(rule.editable ? "修改通过新 revision、服务端 Preview 和独立批准完成，不原地覆盖。" : "该规则由软件版本或兼容适配器管理；标准界面只读。")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={simulationWindow} onValueChange={(value) => onSimulationWindowChange(value as FilterRuleSimulationWindow)}>
              <SelectTrigger aria-label={t("模拟样本窗口")} className="min-h-11 w-[156px] border-[#303a49] bg-[#151b24] text-xs sm:min-h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="current">{t("当前 Inventory")}</SelectItem>
                <SelectItem value="last_30m">{t("最近 30 分钟")}</SelectItem>
                <SelectItem value="last_3h">{t("最近 3 小时")}</SelectItem>
                <SelectItem value="last_24h">{t("最近 24 小时")}</SelectItem>
              </SelectContent>
            </Select>
            {onCreateSuccessor ? <Button type="button" variant="secondary" size="sm" onClick={onCreateSuccessor} disabled={actionLoading} className="min-h-11 border border-[#303a49] bg-[#151b24] text-[#dce2eb] hover:bg-[#1d2530] sm:min-h-9">
              <Plus className="size-3.5" aria-hidden="true" />{t("新建后继草稿")}
            </Button> : null}
            <Button type="button" variant="secondary" size="sm" onClick={onSimulate} disabled={actionLoading} className="min-h-11 border border-[#303a49] bg-[#151b24] text-[#dce2eb] hover:bg-[#1d2530] sm:min-h-9">
              <FlaskConical className="size-3.5" aria-hidden="true" />{t("模拟影响")}
            </Button>
            {rule.editable ? <Button type="button" variant="secondary" size="sm" onClick={onPreview} disabled={actionLoading} className="min-h-11 border border-[#303a49] bg-[#151b24] text-[#dce2eb] hover:bg-[#1d2530] sm:min-h-9">
              {actionLoading ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <SearchCheck className="size-3.5" aria-hidden="true" />}{t("服务端 Preview")}
            </Button> : null}
          </div>
        </div>

        {preview ? (
          <div className={cn("mt-3 rounded border px-3 py-3", preview.valid ? "border-emerald-400/20 bg-emerald-500/5" : "border-rose-400/20 bg-rose-500/5")}>
            <div className="flex items-center gap-2">
              {preview.valid ? <CheckCircle2 className="size-4 text-emerald-300" aria-hidden="true" /> : <AlertTriangle className="size-4 text-rose-300" aria-hidden="true" />}
              <p className={cn("text-xs font-semibold", preview.valid ? "text-emerald-100" : "text-rose-100")}>{t(preview.valid ? "Preview 通过" : "Preview 未通过")}</p>
            </div>
            <p className="mt-2 text-[11px] text-[#b9c1ce]">{preview.matchedAssets} {t("资产")} · {preview.matchedInstances} {t("实例")} · {preview.matchedNodes} {t("节点")} · {preview.conflicts} {t("冲突")}</p>
            {preview.errors.map((error) => <p key={error} className="mt-1 text-[10px] text-rose-200">{error}</p>)}
            {preview.warnings.map((warning) => <p key={warning} className="mt-1 text-[10px] text-amber-200">{warning}</p>)}
          </div>
        ) : null}

        {simulation ? (
          <div className="mt-3 rounded border border-cyan-400/20 bg-cyan-500/5 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-cyan-100">{t("阶段变化模拟")}</p><span className={cn("text-[10px]", simulation.sample.partial ? "text-amber-200" : "text-[#8fcbd4]")}>{t(simulation.sample.source)} · {simulation.sample.evaluated} {t("条样本")}{simulation.sample.partial ? ` · ${t("部分数据")}` : ""}</span></div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {simulation.stageChanges.map((stage) => (
                <div key={stage.stage} className="rounded border border-[#2b3544] bg-[#121923] p-2.5">
                  <p className="font-mono text-[10px] font-semibold text-[#fb923c]">{stage.stage.toUpperCase()}</p>
                  <p className="mt-1 text-xs text-[#dce2eb]">{stage.changed}/{stage.evaluated} {t("对象会变化")}</p>
                </div>
              ))}
            </div>
            {simulation.sample.reasons.length ? <p className="mt-2 text-[10px] leading-4 text-amber-200">{simulation.sample.reasons.map(t).join(" / ")}</p> : null}
          </div>
        ) : null}

        {rule.editable && rule.lifecycleStage !== "revoked" ? (
          <div className="mt-4 border-t border-[#27303d] pt-4">
            <label htmlFor={reasonId} className="text-xs font-semibold text-[#cbd2dd]">{t("变更原因")} <span className="text-rose-300">*</span></label>
            <p className="mt-1 text-[11px] text-[#7f899b]">{t("原因会写入新 revision 和审计记录。")}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Input id={reasonId} value={reason} onChange={(event) => onReasonChange(event.target.value)} className="min-h-11 min-w-64 flex-1 border-[#303a49] bg-[#141a23] text-sm sm:min-h-9" />
              {rule.lifecycleStage === "draft" ? <Button type="button" size="sm" onClick={onShadow} disabled={actionLoading || !reason.trim() || !preview?.canEnterShadow} className="min-h-11 bg-amber-500 text-[#1a1003] hover:bg-amber-400 sm:min-h-9">{t("进入观察")}</Button> : null}
              {rule.lifecycleStage === "shadow" ? <Button type="button" size="sm" onClick={onPromote} disabled={actionLoading || !reason.trim() || !preview?.canPromote} className="min-h-11 bg-emerald-500 text-[#06150d] hover:bg-emerald-400 sm:min-h-9">{t("批准生效")}</Button> : null}
              <Button type="button" variant="secondary" size="sm" onClick={onRevoke} disabled={actionLoading || !reason.trim()} className="min-h-11 border border-rose-400/25 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20 sm:min-h-9"><Ban className="size-3.5" aria-hidden="true" />{t("停用")}</Button>
            </div>
            {rule.lifecycleStage === "shadow" ? <p className="mt-2 text-[10px] text-amber-200">{t("批准人必须不同于创建人；浏览器不能自行声明审批身份。")}</p> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
