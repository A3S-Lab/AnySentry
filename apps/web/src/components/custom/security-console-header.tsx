import dayjs from "dayjs";
import { ChevronLeft, ChevronRight, Clock3, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import {
  createContext,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { LanguageSelector } from "@/components/custom/language-selector";
import { MobileSecurityNavigation } from "@/components/custom/mobile-security-navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SecurityTimeFilter, SecurityTimeType } from "@/lib/api/security-center";
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
  { value: "custom", label: "自定义" },
];

interface SecurityConsoleContextValue {
  filter: SecurityTimeFilter;
  setTimeFilter: (filter: SecurityTimeFilter) => void;
  refreshVersion: number;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  setSidebarWidth: Dispatch<SetStateAction<number>>;
  toggleSidebar: () => void;
}

const SecurityConsoleContext = createContext<SecurityConsoleContextValue | null>(null);

export const DEFAULT_SECURITY_SIDEBAR_WIDTH = 220;
export const MIN_SECURITY_SIDEBAR_WIDTH = 180;
export const MAX_SECURITY_SIDEBAR_WIDTH = 560;
export const COLLAPSED_SECURITY_SIDEBAR_WIDTH = 64;
const SIDEBAR_WIDTH_STORAGE_KEY = "anysentry.security-sidebar.width";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "anysentry.security-sidebar.collapsed";

function filterFromSearch(search: string): SecurityTimeFilter {
  const params = new URLSearchParams(search);
  const requested = params.get("timeType") as SecurityTimeType | null;
  const timeType = TIME_OPTIONS.some((option) => option.value === requested) ? requested! : "last_3h";
  return {
    timeType,
    startTime: timeType === "custom" ? params.get("startTime") ?? undefined : undefined,
    endTime: timeType === "custom" ? params.get("endTime") ?? undefined : undefined,
    snapshotAsOf: params.get("snapshotAsOf") ?? new Date().toISOString(),
  };
}

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SECURITY_SIDEBAR_WIDTH, Math.max(MIN_SECURITY_SIDEBAR_WIDTH, Math.round(width)));
}

function initialSidebarWidth() {
  if (typeof window === "undefined") return DEFAULT_SECURITY_SIDEBAR_WIDTH;
  const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0
    ? clampSidebarWidth(stored)
    : DEFAULT_SECURITY_SIDEBAR_WIDTH;
}

function initialSidebarCollapsed() {
  return typeof window !== "undefined"
    && window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
}

export function useSecurityConsole() {
  const context = useContext(SecurityConsoleContext);
  if (!context) throw new Error("useSecurityConsole must be used inside SecurityConsoleProvider");
  return context;
}

export function SecurityConsoleProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<SecurityTimeFilter>(() => filterFromSearch(location.search));
  const [customStart, setCustomStart] = useState(() => dayjs().subtract(1, "day").format("YYYY-MM-DD"));
  const [customEnd, setCustomEnd] = useState(() => dayjs().format("YYYY-MM-DD"));
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [clock, setClock] = useState(() => dayjs());
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [sidebarResizing, setSidebarResizing] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(dayjs()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(sidebarWidth)));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has("snapshotAsOf")) {
      params.set("timeType", filter.timeType ?? "last_3h");
      params.set("snapshotAsOf", filter.snapshotAsOf ?? new Date().toISOString());
      if (filter.timeType === "custom" && filter.startTime && filter.endTime) {
        params.set("startTime", filter.startTime);
        params.set("endTime", filter.endTime);
      }
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
      return;
    }
    const routed = filterFromSearch(location.search);
    setFilter((current) => (
      current.timeType === routed.timeType &&
      current.startTime === routed.startTime &&
      current.endTime === routed.endTime &&
      current.snapshotAsOf === routed.snapshotAsOf
        ? current
        : routed
    ));
    if (routed.timeType === "custom") {
      if (routed.startTime) setCustomStart(dayjs(routed.startTime).format("YYYY-MM-DD"));
      if (routed.endTime) setCustomEnd(dayjs(routed.endTime).format("YYYY-MM-DD"));
    }
  }, [location.pathname, location.search, navigate]);

  const setTimeFilter = (next: SecurityTimeFilter) => {
    const resolved: SecurityTimeFilter = {
      ...next,
      timeType: next.timeType ?? "last_3h",
      snapshotAsOf: next.snapshotAsOf ?? new Date().toISOString(),
    };
    setFilter(resolved);
    const params = new URLSearchParams(location.search);
    params.set("timeType", resolved.timeType ?? "last_3h");
    params.set("snapshotAsOf", resolved.snapshotAsOf!);
    if (resolved.timeType === "custom" && resolved.startTime && resolved.endTime) {
      params.set("startTime", resolved.startTime);
      params.set("endTime", resolved.endTime);
    } else {
      params.delete("startTime");
      params.delete("endTime");
    }
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  };

  const customError = useMemo(() => {
    if (!customStart || !customEnd) return "请选择开始和结束日期";
    if (dayjs(customEnd).isBefore(dayjs(customStart), "day")) return "结束日期不能早于开始日期";
    if (dayjs(customEnd).isAfter(dayjs(), "day")) return "结束日期不能晚于今天";
    return undefined;
  }, [customEnd, customStart]);

  const handleTimeTypeChange = (value: SecurityTimeType) => {
    if (value === "custom") {
      setTimeFilter({
        timeType: value,
        startTime: dayjs(customStart).startOf("day").toISOString(),
        endTime: dayjs(customEnd).endOf("day").toISOString(),
      });
      return;
    }
    setTimeFilter({ timeType: value });
  };

  const applyCustomTime = () => {
    if (customError) return;
    setTimeFilter({
      timeType: "custom",
      startTime: dayjs(customStart).startOf("day").toISOString(),
      endTime: dayjs(customEnd).endOf("day").toISOString(),
    });
  };

  const requestRefresh = () => {
    setRefreshing(true);
    setTimeFilter({ ...filter, snapshotAsOf: new Date().toISOString() });
    setRefreshVersion((value) => value + 1);
    window.setTimeout(() => setRefreshing(false), 700);
  };
  const toggleSidebar = () => setSidebarCollapsed((collapsed) => !collapsed);
  const startSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || sidebarCollapsed) return;
    event.preventDefault();
    setSidebarResizing(true);
    const shellLeft = event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    const body = document.body;
    const previousCursor = body.style.cursor;
    const previousUserSelect = body.style.userSelect;
    body.style.cursor = "col-resize";
    body.style.userSelect = "none";

    const move = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(moveEvent.clientX - shellLeft));
    };
    const stop = () => {
      setSidebarResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      body.style.cursor = previousCursor;
      body.style.userSelect = previousUserSelect;
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };
  const contextValue = useMemo<SecurityConsoleContextValue>(() => ({
    filter,
    setTimeFilter,
    refreshVersion,
    sidebarWidth,
    sidebarCollapsed,
    setSidebarWidth,
    toggleSidebar,
  }), [filter, refreshVersion, sidebarCollapsed, sidebarWidth, location.pathname, location.search]);

  return (
    <SecurityConsoleContext.Provider value={contextValue}>
      <div className="relative flex h-full w-full flex-col overflow-hidden">
        <header className="shrink-0 border-b border-[#232a37] bg-[#0f131a] text-zinc-100">
          <div className="flex min-h-16 items-center">
            <div
              className={cn(
                "relative flex h-16 w-auto shrink-0 items-center gap-2 border-r border-[#303948] px-2 lg:w-[var(--security-sidebar-width)]",
                sidebarCollapsed ? "lg:px-2" : "lg:px-4",
              )}
              style={{
                "--security-sidebar-width": `${sidebarCollapsed ? COLLAPSED_SECURITY_SIDEBAR_WIDTH : sidebarWidth}px`,
              } as CSSProperties}
            >
              <MobileSecurityNavigation />
              <ShieldCheck className="hidden size-5 shrink-0 text-teal-300 sm:block" />
              {!sidebarCollapsed ? (
                <h1 className="hidden min-w-0 truncate pr-6 text-sm font-semibold tracking-normal text-zinc-50 sm:block">
                  {t("Agent态势感知")} <span className="text-zinc-300">AnySentry</span>
                </h1>
              ) : null}
              <button
                type="button"
                onClick={toggleSidebar}
                title={sidebarCollapsed ? t("展开左侧导航") : t("收起左侧导航")}
                aria-label={sidebarCollapsed ? t("展开左侧导航") : t("收起左侧导航")}
                className={cn(
                  "absolute z-40 hidden items-center justify-center rounded text-[#788296] transition-colors hover:bg-white/5 hover:text-teal-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-400 lg:inline-flex",
                  sidebarCollapsed
                    ? "right-1 top-1/2 size-6 -translate-y-1/2"
                    : "right-1 top-1/2 size-7 -translate-y-1/2",
                )}
              >
                {sidebarCollapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
              </button>
            </div>

            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 px-4 py-3">
              <Select
                value={filter.timeType ?? "last_3h"}
                onValueChange={(value) => handleTimeTypeChange(value as SecurityTimeType)}
              >
                <SelectTrigger className="h-11 w-[132px] border-white/10 bg-white/5 text-xs text-zinc-100 sm:h-9">
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
                    className="h-11 w-[145px] border-white/10 bg-white/5 text-xs text-zinc-100 sm:h-9"
                  />
                  <span className="text-xs text-zinc-500">{t("至")}</span>
                  <Input
                    type="date"
                    value={customEnd}
                    max={dayjs().format("YYYY-MM-DD")}
                    onChange={(event) => setCustomEnd(event.target.value)}
                    className="h-11 w-[145px] border-white/10 bg-white/5 text-xs text-zinc-100 sm:h-9"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={Boolean(customError)}
                    onClick={applyCustomTime}
                    className="h-11 bg-teal-500 text-[#07100c] hover:bg-teal-400 sm:h-9"
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
                className="h-11 border border-white/10 bg-white/5 text-zinc-100 hover:bg-white/10 sm:h-9"
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
        {!sidebarCollapsed ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("调整左侧导航宽度")}
            aria-valuemin={MIN_SECURITY_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SECURITY_SIDEBAR_WIDTH}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
            title={t("拖动调整导航宽度，双击恢复默认")}
            onPointerDown={startSidebarResize}
            onDoubleClick={() => setSidebarWidth(DEFAULT_SECURITY_SIDEBAR_WIDTH)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
              event.preventDefault();
              setSidebarWidth((current) => {
                if (event.key === "Home") return DEFAULT_SECURITY_SIDEBAR_WIDTH;
                return clampSidebarWidth(current + (event.key === "ArrowRight" ? 10 : -10));
              });
            }}
            className={cn(
              "absolute inset-y-0 z-[60] hidden w-[6px] -translate-x-1/2 cursor-col-resize touch-none bg-transparent outline-none transition-colors hover:bg-teal-400/30 focus-visible:bg-teal-400/40 lg:block",
              sidebarResizing && "bg-teal-400/40",
            )}
            style={{ left: sidebarWidth }}
          />
        ) : null}
      </div>
    </SecurityConsoleContext.Provider>
  );
}
