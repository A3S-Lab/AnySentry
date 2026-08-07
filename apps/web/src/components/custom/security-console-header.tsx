import dayjs from "dayjs";
import { Clock3, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { LanguageSelector } from "@/components/custom/language-selector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SecurityTimeFilter, SecurityTimeType } from "@/lib/api/security-center";
import { useI18n } from "@/lib/i18n";

const TIME_OPTIONS: Array<{ value: SecurityTimeType; label: string }> = [
  { value: "last_3h", label: "近3小时" },
  { value: "last_1d", label: "近一天" },
  { value: "last_7d", label: "近一周" },
  { value: "last_30d", label: "近一月" },
  { value: "custom", label: "自定义" },
];

interface SecurityConsoleContextValue {
  filter: SecurityTimeFilter;
  refreshVersion: number;
}

const SecurityConsoleContext = createContext<SecurityConsoleContextValue | null>(null);

export function useSecurityConsole() {
  const context = useContext(SecurityConsoleContext);
  if (!context) throw new Error("useSecurityConsole must be used inside SecurityConsoleProvider");
  return context;
}

export function SecurityConsoleProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<SecurityTimeFilter>({ timeType: "last_3h" });
  const [customStart, setCustomStart] = useState(() => dayjs().subtract(1, "day").format("YYYY-MM-DD"));
  const [customEnd, setCustomEnd] = useState(() => dayjs().format("YYYY-MM-DD"));
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [clock, setClock] = useState(() => dayjs());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(dayjs()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const customError = useMemo(() => {
    if (!customStart || !customEnd) return "请选择开始和结束日期";
    if (dayjs(customEnd).isBefore(dayjs(customStart), "day")) return "结束日期不能早于开始日期";
    if (dayjs(customEnd).isAfter(dayjs(), "day")) return "结束日期不能晚于今天";
    return undefined;
  }, [customEnd, customStart]);

  const handleTimeTypeChange = (value: SecurityTimeType) => {
    if (value === "custom") {
      setFilter({
        timeType: value,
        startTime: dayjs(customStart).startOf("day").toISOString(),
        endTime: dayjs(customEnd).endOf("day").toISOString(),
      });
      return;
    }
    setFilter({ timeType: value });
  };

  const applyCustomTime = () => {
    if (customError) return;
    setFilter({
      timeType: "custom",
      startTime: dayjs(customStart).startOf("day").toISOString(),
      endTime: dayjs(customEnd).endOf("day").toISOString(),
    });
  };

  const requestRefresh = () => {
    setRefreshing(true);
    setRefreshVersion((value) => value + 1);
    window.setTimeout(() => setRefreshing(false), 700);
  };

  return (
    <SecurityConsoleContext.Provider value={{ filter, refreshVersion }}>
      <div className="flex h-full w-full flex-col overflow-hidden">
        <header className="shrink-0 border-b border-[#232a37] bg-[#0f131a] text-zinc-100">
          <div className="flex min-h-16 items-center">
            <div className="flex h-16 w-[220px] shrink-0 items-center gap-2 border-r border-[#232a37] px-4">
              <ShieldCheck className="size-5 shrink-0 text-teal-300" />
              <h1 className="min-w-0 truncate text-sm font-semibold tracking-normal text-zinc-50">
                {t("安全监控中台")} <span className="text-zinc-300">AnySentry</span>
              </h1>
            </div>

            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 px-4 py-3">
              <Select
                value={filter.timeType ?? "last_3h"}
                onValueChange={(value) => handleTimeTypeChange(value as SecurityTimeType)}
              >
                <SelectTrigger className="h-9 w-[132px] border-white/10 bg-white/5 text-xs text-zinc-100">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIME_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{t(option.label)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {filter.timeType === "custom" ? (
                <>
                  <Input
                    type="date"
                    value={customStart}
                    max={dayjs().format("YYYY-MM-DD")}
                    onChange={(event) => setCustomStart(event.target.value)}
                    className="h-9 w-[145px] border-white/10 bg-white/5 text-xs text-zinc-100"
                  />
                  <span className="text-xs text-zinc-500">{t("至")}</span>
                  <Input
                    type="date"
                    value={customEnd}
                    max={dayjs().format("YYYY-MM-DD")}
                    onChange={(event) => setCustomEnd(event.target.value)}
                    className="h-9 w-[145px] border-white/10 bg-white/5 text-xs text-zinc-100"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={Boolean(customError)}
                    onClick={applyCustomTime}
                    className="h-9 bg-teal-500 text-[#07100c] hover:bg-teal-400"
                  >
                    {t("应用")}
                  </Button>
                </>
              ) : null}

              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={requestRefresh}
                className="h-9 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10"
              >
                {refreshing ? <LoaderCircle className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
                {t("刷新")}
              </Button>
              <LanguageSelector />
              <div className="flex items-center gap-1.5 whitespace-nowrap text-xs text-zinc-500">
                <Clock3 className="size-3.5" />
                <span>{clock.format("MM-DD HH:mm:ss")}</span>
              </div>
            </div>
          </div>
          {filter.timeType === "custom" && customError ? (
            <p className="border-t border-[#232a37] px-4 py-1.5 text-right text-xs text-rose-200">{t(customError)}</p>
          ) : null}
        </header>
        {children}
      </div>
    </SecurityConsoleContext.Provider>
  );
}
