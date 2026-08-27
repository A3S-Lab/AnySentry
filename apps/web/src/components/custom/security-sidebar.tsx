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
  MessageSquareText,
  Network,
  PlugZap,
  RadioTower,
  ShieldAlert,
  ShieldCheck,
  Siren,
  SlidersHorizontal,
  Sparkles,
  ServerCog,
  Target,
  TerminalSquare,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import {
  COLLAPSED_SECURITY_SIDEBAR_WIDTH,
  useSecurityConsole,
} from "@/components/custom/security-console-header";
import { SidebarUserControl } from "@/components/custom/sidebar-user-control";
import { useI18n } from "@/lib/i18n";
import { prefetchRoute } from "@/lib/performance/route-loaders";
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
    label: "AI 平台",
    icon: Sparkles,
    items: [
      { label: "AI 对话", description: "智能调查与证据分析", href: "/ai/chat", icon: MessageSquareText },
      { label: "AI Operator", description: "辅助生成处置计划", href: "/operator", icon: Zap },
      { label: "Agent 安全接入", description: "执行前防护与安全能力", href: "/capabilities", icon: ShieldCheck },
    ],
  },
  {
    label: "全局概览",
    icon: LayoutDashboard,
    items: [
      { label: "运行总览", description: "平台健康与实时状态", href: "/?view=overview", icon: Activity, dashboardView: "overview" },
      { label: "平台监控", description: "主机、容器与服务指标", href: "/platform", icon: ServerCog },
      { label: "风险态势", description: "风险分类与趋势分布", href: "/?view=risk", icon: Siren, dashboardView: "risk" },
      { label: "会话与工作区", description: "会话风险与 Workspace 资产", href: "/?view=workspace", icon: TerminalSquare, dashboardView: "workspace" },
    ],
  },
  {
    label: "告警中心",
    icon: BellRing,
    items: [
      { label: "告警列表", description: "活跃告警与处置", href: "/alerts", icon: BellRing },
      { label: "Incident", description: "安全事件调查与跟踪", href: "/incidents", icon: ShieldAlert },
      { label: "响应处置", description: "响应任务与执行证据", href: "/remediation", icon: FileCheck2 },
      { label: "通知路由", description: "通知渠道与告警路由", href: "/notifications", icon: Megaphone },
    ],
  },
  {
    label: "Agent 观测",
    icon: Bot,
    items: [
      { label: "Agent 列表", description: "Agent 清单与运行状态", href: "/?view=agentAssets", icon: Bot, dashboardView: "agentAssets" },
      { label: "资产与身份", description: "Agent、服务与待识别对象", href: "/assets", icon: ShieldCheck },
      { label: "Agent 态势", description: "实例活动与研判健康", href: "/?view=agentInstances", icon: Activity, dashboardView: "agentInstances" },
      { label: "Agent 拓扑", description: "Agent 运行时安全关系", href: "/topology", icon: Network },
      { label: "对话追踪", description: "Agent 对话与上下文追踪", href: "/conversations", icon: MessageSquareText },
      { label: "运行链路", description: "无侵入事件时间线", href: "/?view=events", icon: GitBranch, dashboardView: "events" },
      { label: "复合研判", description: "Flink 连续行为关联", href: "/?view=stream", icon: Sparkles, dashboardView: "stream" },
      { label: "供应链漏洞", description: "OSV 依赖漏洞资产", href: "/?view=supplyChain", icon: ShieldAlert, dashboardView: "supplyChain" },
    ],
  },
  {
    label: "安装部署",
    icon: Layers3,
    items: [
      { label: "数据接入", description: "事件来源与可信身份", href: "/sources", icon: PlugZap },
      { label: "采集链路", description: "Collector 健康与覆盖", href: "/collectors", icon: RadioTower },
      { label: "维护窗口", description: "维护窗口与告警抑制", href: "/maintenance", icon: CalendarClock },
      { label: "覆盖盲区", description: "采集与监控盲区", href: "/coverage", icon: EyeOff },
      { label: "监控目标", description: "持续监控目标", href: "/objectives", icon: Target },
      { label: "过滤规则", description: "F0/F1/F2/F3 统一规则治理", href: "/filter-rules", icon: ListFilter },
      { label: "审计日志", description: "管理操作审计记录", href: "/audit", icon: KeyRound },
    ],
  },
  {
    label: "配置管理",
    icon: SlidersHorizontal,
    items: [
      { label: "策略配置", description: "L1 / L2 / L3 研判策略", href: "/admin/policy", icon: SlidersHorizontal },
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
      <div className="flex h-full min-h-0 flex-col">
        <div className="mr-1 min-h-0 flex-1 overflow-y-auto p-1.5">
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
                        onMouseEnter={() => prefetchRoute(item.href)}
                        onFocus={() => prefetchRoute(item.href)}
                        className={cn(
                          "flex w-full items-start gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60",
                          active
                            ? "border-transparent bg-[radial-gradient(circle_at_100%_50%,rgba(37,99,235,0.72),transparent_24%),linear-gradient(90deg,rgba(6,28,54,0.96),rgba(15,43,98,0.92))] text-[#f4f8ff] shadow-[inset_2px_0_0_#22d3ee,inset_0_0_22px_rgba(37,99,235,0.18)]"
                            : "border-transparent text-[#b6bdcc] hover:bg-[#151a23] hover:text-[#e8ecf3]",
                          sidebarCollapsed && "justify-center px-0",
                        )}
                      >
                        <span className={cn(
                          "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center",
                          active ? "text-[#22d3ee]" : "text-[#818a9c]",
                        )}>
                          <Icon className="size-3.5" />
                        </span>
                        {!sidebarCollapsed ? (
                          <span className="min-w-0">
                            <span className="block text-xs font-semibold leading-[1.45]">{t(item.label)}</span>
                            {item.description ? (
                              <span className={cn(
                                "mt-0.5 block text-[10.5px] leading-4",
                                active ? "text-[#9eb3d2]" : "text-[#5b6373]",
                              )}>
                                {t(item.description)}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </nav>
        </div>
        <SidebarUserControl collapsed={sidebarCollapsed} />
      </div>
    </aside>
  );
}
