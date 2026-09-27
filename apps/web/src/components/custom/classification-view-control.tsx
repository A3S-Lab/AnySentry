import type { ClassificationView } from "@/lib/api/security-center";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const OPTIONS: Array<{ value: ClassificationView; label: string; hint: string }> = [
  {
    value: "as_observed",
    label: "发生时",
    hint: "保持事件发生时的身份与审计结论",
  },
  {
    value: "current_effective",
    label: "当前资产",
    hint: "应用当前资产与人工审核，不改写历史风险结果",
  },
];

export function ClassificationViewControl({
  value,
  onChange,
  className,
}: {
  value: ClassificationView;
  onChange: (value: ClassificationView) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const selected = OPTIONS.find((option) => option.value === value) ?? OPTIONS[0];
  return (
    <div className={cn("min-w-0", className)}>
      <div className="inline-flex min-h-11 rounded-md border border-[#2e3645] bg-[#151a23] p-0.5 sm:min-h-9" role="group" aria-label={t("分类口径")}>
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              "min-h-10 rounded px-3 text-xs font-medium transition-colors sm:min-h-8",
              value === option.value
                ? "bg-[#2a303b] text-[#f4f6fa] shadow-[inset_0_0_0_1px_rgba(249,115,22,0.35)]"
                : "text-[#818a9c] hover:text-[#d6dbe5]",
            )}
          >
            {t(option.label)}
          </button>
        ))}
      </div>
      <p className="mt-1 text-[10px] leading-4 text-[#697386]">{t(selected.hint)}</p>
    </div>
  );
}
