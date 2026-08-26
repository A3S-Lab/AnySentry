import {
  Activity,
  BellRing,
  Bot,
  CalendarClock,
  EyeOff,
  FileCheck2,
  GitBranch,
  KeyRound,
  Layers3,
  LayoutDashboard,
  ListFilter,
  Megaphone,
  Network,
  PlugZap,
  RadioTower,
  ServerCog,
  ShieldAlert,
  Siren,
  SlidersHorizontal,
  Sparkles,
  Target,
  TerminalSquare,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { AdminTokenControl } from "@/components/custom/admin-token-control";
import {
  COLLAPSED_SECURITY_SIDEBAR_WIDTH,
  useSecurityConsole,
} from "@/components/custom/security-console-header";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface SecurityNavigationItem {
  label: string;
  description?: string;
  href: string;
  icon: LucideIcon;
  dashboardView?: string;
}

export const SECURITY_NAVIGATION_GROUPS: Array<{ label: string; icon: LucideIcon; items: SecurityNavigationItem[] }> = [
  {
    label: "概览",
    icon: LayoutDashboard,
    items: [
      { label: "运行总览", description: "平台健康与实时状态", href: "/?view=overview", icon: Activity, dashboardView: "overview" },
      { label: "拓扑", description: "Agent 运行时安全关系", href: "/topology", icon: Network },
      { label: "风险态势", description: "风险分类与趋势分布", href: "/?view=risk", icon: Siren, dashboardView: "risk" },
      { label: "复合研判", description: "Flink 连续行为关联", href: "/?view=stream", icon: Sparkles, dashboardView: "stream" },
      { label: "告警", description: "活跃告警与处置", href: "/alerts", icon: BellRing },
    ],
  },
  {
    label: "平台监控",
    icon: ServerCog,
    items: [
      { label: "运行链路", description: "无侵入事件时间线", href: "/?view=events", icon: GitBranch, dashboardView: "events" },
      { label: "供应链漏洞", description: "OSV 依赖漏洞资产", href: "/?view=supplyChain", icon: ShieldAlert, dashboardView: "supplyChain" },
      { label: "会话与工作区", description: "Agent 与 Workspace 风险", href: "/?view=workspace", icon: TerminalSquare, dashboardView: "workspace" },
    ],
  },
  {
    label: "资产",
    icon: Layers3,
    items: [
      { label: "接入源", description: "事件来源与可信身份", href: "/sources", icon: PlugZap },
      { label: "采集链路", description: "Collector 健康与覆盖", href: "/collectors", icon: RadioTower },
      { label: "资产与身份", description: "Agent、服务与待识别对象", href: "/assets", icon: Bot },
      { label: "Workspace 资产", description: "工作区清单与归属", href: "/workspaces", icon: Layers3 },
    ],
  },
  {
    label: "运营",
    icon: Siren,
    items: [
      { label: "Incident", description: "安全事件调查与跟踪", href: "/incidents", icon: ShieldAlert },
      { label: "处置", description: "响应任务与执行证据", href: "/remediation", icon: FileCheck2 },
      { label: "AI Operator", description: "辅助生成处置计划", href: "/operator", icon: Zap },
      { label: "通知", description: "通知渠道与告警路由", href: "/notifications", icon: Megaphone },
    ],
  },
  {
    label: "运维",
    icon: Wrench,
    items: [
      { label: "维护", description: "维护窗口与告警抑制", href: "/maintenance", icon: CalendarClock },
      { label: "覆盖", description: "采集与监控盲区", href: "/coverage", icon: EyeOff },
      { label: "目标", description: "持续监控目标", href: "/objectives", icon: Target },
      { label: "过滤规则", description: "F0/F1/F2/F3 统一规则治理", href: "/filter-rules", icon: ListFilter },
      { label: "策略配置", description: "L1 / L2 / L3 研判策略", href: "/admin/policy", icon: SlidersHorizontal },
    ],
  },
  {
    label: "管理",
    icon: SlidersHorizontal,
    items: [
      { label: "API", description: "Progressive API 能力", href: "/capabilities", icon: Sparkles },
      { label: "审计", description: "管理操作审计记录", href: "/audit", icon: KeyRound },
    ],
  },
];

export function isSecurityNavigationItemActive(pathname: string, search: string, item: SecurityNavigationItem): boolean {
  if (item.dashboardView) {
    if (pathname !== "/" && pathname !== "/admin/security-monitor") return false;
    const view = new URLSearchParams(search).get("view") || "overview";
    return view === item.dashboardView;
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function SecuritySidebar() {
  const { pathname, search } = useLocation();
  const { t } = useI18n();
  const { sidebarWidth, sidebarCollapsed } = useSecurityConsole();

  return (
    <aside
      className="relative hidden h-full shrink-0 border-r border-[#232a37] bg-[#0f131a] lg:block"
      style={{ width: sidebarCollapsed ? COLLAPSED_SECURITY_SIDEBAR_WIDTH : sidebarWidth }}
    >
      <div className="mr-1 h-full overflow-y-auto p-1.5">
        <nav className="space-y-1" aria-label={t("安全监控模块")}>
          {SECURITY_NAVIGATION_GROUPS.map((group, groupIndex) => {
            const GroupIcon = group.icon;
            return (
              <div key={group.label}>
                <p
                  className={cn(
                    "flex items-center gap-2 px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[#5b6373]",
                    groupIndex === 0 ? "pt-3" : "mt-3 border-t border-[#232a37] pt-4",
                    sidebarCollapsed && "justify-center px-0",
                  )}
                  title={sidebarCollapsed ? t(group.label) : undefined}
                >
                  <GroupIcon className="size-3.5" />
                  {!sidebarCollapsed ? t(group.label) : null}
                </p>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = isSecurityNavigationItemActive(pathname, search, item);
                  return (
                    <Link
                      key={item.href}
                      to={item.href}
                      title={sidebarCollapsed ? t(item.label) : undefined}
                      aria-label={sidebarCollapsed ? t(item.label) : undefined}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                        active
                          ? "border-transparent bg-[#1c222d] text-[#e8ecf3] shadow-[inset_2px_0_0_#f97316]"
                          : "border-transparent text-[#b6bdcc] hover:bg-[#151a23] hover:text-[#e8ecf3]",
                        sidebarCollapsed && "justify-center px-0",
                      )}
                    >
                      <span className={cn(
                        "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center",
                        active ? "text-[#f97316]" : "text-[#818a9c]",
                      )}>
                        <Icon className="size-3.5" />
                      </span>
                      {!sidebarCollapsed ? (
                        <span className="min-w-0">
                          <span className="block text-xs font-semibold leading-[1.45]">{t(item.label)}</span>
                          {item.description ? (
                            <span className={cn(
                              "mt-0.5 block text-[10.5px] leading-4",
                              active ? "text-[#818a9c]" : "text-[#5b6373]",
                            )}>
                              {t(item.description)}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </Link>
                  );
                })}
                {group.label === "管理" && !sidebarCollapsed ? <AdminTokenControl navigation /> : null}
              </div>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
