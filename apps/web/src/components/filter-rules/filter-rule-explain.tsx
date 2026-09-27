import { AlertTriangle, ArrowDown, CheckCircle2, CircleDashed, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { FilterRuleExplain } from "@/lib/api/filter-rules";

export function FilterRuleExplainPanel({ result }: { result: FilterRuleExplain }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0">
      <section className="border-b border-[#27303d] px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-cyan-300">{t("规则解释")}</p>
            <h2 className="mt-1 break-words text-base font-semibold text-[#edf1f7] [overflow-wrap:anywhere]">{result.subject.label}</h2>
            <p className="mt-1 font-mono text-[10px] text-[#697386]">{result.subject.type} · {result.subject.id}</p>
          </div>
          <span className={cn(
            "inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-semibold",
            result.context.conflict ? "border-amber-400/25 bg-amber-500/10 text-amber-100" : "border-emerald-400/25 bg-emerald-500/10 text-emerald-100",
          )}>
            {result.context.conflict ? <AlertTriangle className="size-3.5" aria-hidden="true" /> : <ShieldCheck className="size-3.5" aria-hidden="true" />}
            {t(result.context.conflict ? "存在规则冲突，按安全优先级处理" : "无身份冲突")}
          </span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {result.context.facts.map((fact) => (
            <div key={`${fact.label}:${fact.value}`} className="min-w-0 rounded border border-[#2b3544] bg-[#141a23] px-3 py-2.5">
              <p className="text-[10px] text-[#778194]">{t(fact.label)} · {fact.source}</p>
              <p className="mt-1 break-words text-xs font-medium text-[#e2e7ef] [overflow-wrap:anywhere]">{fact.value}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-[#cbd2dd]">{t("F0 → F1 → F2 → F3 决策链")}</p>
            <p className="mt-1 text-[11px] text-[#7f899b]">{t("每一级都使用中央 Catalog 的同一 ruleId/revision lineage。")}</p>
          </div>
          <span className="max-w-[46%] break-words text-right text-xs font-semibold text-[#edf1f7]">{result.finalOutcome}</span>
        </div>
        <div className="mt-3 grid gap-2 xl:grid-cols-4">
          {result.stages.map((stage, index) => {
            const matched = stage.candidates.filter((candidate) => candidate.matched);
            return (
              <div key={stage.stage} className="relative min-w-0 rounded border border-[#2b3544] bg-[#111720] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-[#fb923c]">{stage.stage.toUpperCase()}</span>
                  {stage.winner ? <CheckCircle2 className="size-3.5 text-emerald-300" aria-hidden="true" /> : <CircleDashed className="size-3.5 text-[#697386]" aria-hidden="true" />}
                </div>
                <p className="mt-2 min-h-10 text-xs font-semibold leading-5 text-[#e1e6ee]">{stage.winner?.name ?? t("没有规则命中")}</p>
                <p className="mt-1 line-clamp-3 text-[10px] leading-4 text-[#7f899b]">{stage.reason}</p>
                <div className="mt-3 border-t border-[#283140] pt-2">
                  <p className="text-[10px] text-[#697386]">{matched.length} {t("条候选命中")} · v{stage.domainVersion}</p>
                  {stage.winner ? <Link to={`/filter-rules?ruleId=${encodeURIComponent(stage.winner.ruleId)}`} className="mt-1 block truncate font-mono text-[9px] text-cyan-300 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f97316]" title={`${stage.winner.ruleId} · r${stage.winner.revision}`}>{stage.winner.ruleId} · r{stage.winner.revision}</Link> : null}
                  {stage.failOpen ? <p className="mt-1 text-[10px] text-amber-200">{t("Discovery-safe fail-open")}</p> : null}
                </div>
                {index < result.stages.length - 1 ? <ArrowDown className="absolute -bottom-2.5 left-1/2 z-10 size-5 -translate-x-1/2 rounded-full border border-[#2b3544] bg-[#111720] p-1 text-[#687385] xl:hidden" aria-hidden="true" /> : null}
              </div>
            );
          })}
        </div>
        {result.warnings.length ? (
          <div role="status" className="mt-3 rounded border border-amber-400/20 bg-amber-500/8 px-3 py-2 text-[11px] leading-5 text-amber-100">
            {result.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          </div>
        ) : null}
      </section>
    </div>
  );
}
