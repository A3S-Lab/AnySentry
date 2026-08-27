import { Globe2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type AppLocale, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function LanguageSelector({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();

  return (
    <Select value={locale} onValueChange={(value) => setLocale(value as AppLocale)}>
      <SelectTrigger
        className={cn("h-11 w-[142px] border-[#2e3645] bg-[#151a23] text-xs text-[#b6bdcc] sm:h-9", className)}
        aria-label={t("语言")}
      >
        <Globe2 className="mr-2 size-3.5 shrink-0 text-[#818a9c]" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="border-[#2e3645] bg-[#0f131a] text-[#b6bdcc]">
        <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#5b6373]">
          {t("语言")}
        </div>
        <SelectItem value="en">English</SelectItem>
        <SelectItem value="zh-CN">中文（简体）</SelectItem>
      </SelectContent>
    </Select>
  );
}
