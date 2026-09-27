import { ChevronRight, LoaderCircle, LockKeyhole, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { FilterRuleSummary } from "@/lib/api/filter-rules";

function lifecycleTone(stage: FilterRuleSummary["lifecycleStage"]) {
  if (stage === "enforced") return "border-emerald-400/25 bg-emerald-500/10 text-emerald-100";
  if (stage === "shadow") return "border-amber-400/25 bg-amber-500/10 text-amber-100";
  if (stage === "revoked") return "border-slate-500/30 bg-slate-500/10 text-slate-300";
  return "border-sky-400/25 bg-sky-500/10 text-sky-100";
}

export function FilterRuleList({
  items,
  total,
  selectedRuleId,
  loadingMore,
  canLoadMore,
  onSelect,
  onLoadMore,
}: {
  items: FilterRuleSummary[];
  total: number;
  selectedRuleId?: string;
  loadingMore: boolean;
  canLoadMore: boolean;
  onSelect: (ruleId: string) => void;
  onLoadMore: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" aria-label={t("规则目录")}>
      {items.map((rule, index) => {
        const selected = selectedRuleId === rule.ruleId;
        const stages = rule.stageImpacts.filter((impact) => impact.applicability !== "not_applicable");
        const previousCategory = index > 0 ? items[index - 1].category : undefined;
        return (
          <div key={rule.ruleId}>
            {rule.category !== previousCategory ? (
              <div className="sticky top-0 z-10 flex min-h-8 items-center justify-between border-b border-t border-[#252e3b] bg-[#111720]/95 px-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#7f899b] backdrop-blur-sm first:border-t-0">
                <span>{t(rule.categoryLabel)}</span>
                <span>{items.filter((item) => item.category === rule.category).length}</span>
              </div>
            ) : null}
            <button
              type="button"
              aria-current={selected ? "page" : undefined}
              onClick={() => onSelect(rule.ruleId)}
              className={cn(
                "group grid min-h-[108px] w-full grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-[#252e3b] px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f97316]",
                selected ? "bg-[#1d2530] shadow-[inset_2px_0_0_#f97316]" : "bg-[#10151d] hover:bg-[#161d27]",
              )}
            >
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2">
                  {rule.editable ? <Settings2 className="size-3.5 shrink-0 text-[#8d97a9]" aria-label={t("可治理")} /> : <LockKeyhole className="size-3.5 shrink-0 text-[#697386]" aria-label={t("只读规则")} />}
                  <span className="min-w-0 break-words text-sm font-semibold text-[#edf1f7] [overflow-wrap:anywhere]">{rule.name}</span>
                </span>
                <span className="mt-1.5 block text-[11px] leading-5 text-[#8d97a9]">{t(rule.kindLabel)} · {t(rule.sourceLabel)}</span>
                <span className="mt-0.5 line-clamp-2 block text-[11px] leading-5 text-[#b9c1ce]">{rule.matcherText}</span>
                <span className="mt-2 flex flex-wrap gap-1.5">
                  {stages.map((impact) => (
                    <span key={impact.stage} className={cn(
                      "inline-flex rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase",
                      impact.applicability === "active" ? "border-cyan-400/20 bg-cyan-500/8 text-cyan-200" : "border-[#303b4b] bg-[#151c26] text-[#7f899b]",
                    )}>{impact.stage}</span>
                  ))}
                  {rule.conflicts ? <span className="inline-flex rounded border border-rose-400/20 bg-rose-500/10 px-1.5 py-0.5 text-[9px] text-rose-200">{rule.conflicts} {t("冲突")}</span> : null}
                </span>
              </span>
              <span className="flex min-h-full flex-col items-end justify-between gap-2">
                <span className={cn("inline-flex rounded border px-2 py-0.5 text-[10px] font-semibold", lifecycleTone(rule.lifecycleStage))}>{t(rule.lifecycleStage)}</span>
                <span className="font-mono text-[10px] text-[#5f6979]">r{rule.revision}</span>
                <ChevronRight className={cn("size-4", selected ? "text-[#fb923c]" : "text-[#4d5767] group-hover:text-[#8d97a9]")} aria-hidden="true" />
              </span>
            </button>
          </div>
        );
      })}
      <div className="flex min-h-14 items-center justify-center border-t border-[#252e3b] px-3">
        {canLoadMore ? (
          <Button type="button" variant="secondary" size="sm" onClick={onLoadMore} disabled={loadingMore} className="min-h-11 border border-[#303a49] bg-[#151b24] text-[#d7dce5] hover:bg-[#1d2530] sm:min-h-9">
            {loadingMore ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
            {t("加载更多规则")} · {items.length}/{total}
          </Button>
        ) : <span className="text-[11px] text-[#697386]">{items.length}/{total} {t("条规则")}</span>}
      </div>
    </div>
  );
}
