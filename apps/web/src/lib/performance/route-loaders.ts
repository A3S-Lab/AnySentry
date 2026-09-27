import type { ComponentType } from "react";

type PageModule = { default: ComponentType };
type PageLoader = () => Promise<PageModule>;

const pageLoaders: Record<string, PageLoader> = {
  "/ai/chat": () => import("@/pages/AIAssistantPage"),
  "/agents": () => import("@/pages/AgentsPage"),
  "/alerts": () => import("@/pages/AlertsPage"),
  "/assets": () => import("@/pages/AssetsPage"),
  "/audit": () => import("@/pages/AuditPage"),
  "/capabilities": () => import("@/pages/CapabilitiesPage"),
  "/collectors": () => import("@/pages/CollectorsPage"),
  "/conversations": () => import("@/pages/ConversationTrackingPage"),
  "/coverage": () => import("@/pages/CoveragePage"),
  "/evidence": () => import("@/pages/EvidenceBundlePage"),
  "/events": () => import("@/pages/AgentEventsPage"),
  "/filter-rules": () => import("@/pages/FilterRulesPage"),
  "/incidents": () => import("@/pages/IncidentsPage"),
  "/maintenance": () => import("@/pages/MaintenancePage"),
  "/notifications": () => import("@/pages/NotificationsPage"),
  "/objectives": () => import("@/pages/ObjectivesPage"),
  "/operator": () => import("@/pages/OperatorPage"),
  "/platform": () => import("@/pages/PlatformMonitoringPage"),
  "/remediation": () => import("@/pages/RemediationPage"),
  "/sources": () => import("@/pages/SourcesPage"),
  "/topology": () => import("@/pages/TopologyPage"),
  "/users": () => import("@/pages/UsersPage"),
  "/workspaces": () => import("@/pages/WorkspacesPage"),
  "/admin/policy": () => import("@/pages/PolicyConfigPage"),
};

export function lazyRoute(pathname: string) {
  return async () => {
    const loader = pageLoaders[pathname];
    if (!loader) throw new Error(`Unknown lazy route: ${pathname}`);
    const module = await loader();
    return { Component: module.default };
  };
}

const prefetchedRoutes = new Set<string>();

export function prefetchRoute(href: string): void {
  if (typeof window === "undefined") return;
  const connection = (window.navigator as Navigator & {
    connection?: { saveData?: boolean };
  }).connection;
  if (connection?.saveData) return;

  const pathname = new URL(href, window.location.origin).pathname;
  const loader = pageLoaders[pathname];
  if (!loader || prefetchedRoutes.has(pathname)) return;

  prefetchedRoutes.add(pathname);
  void loader().catch(() => {
    // A transient chunk failure must remain retryable on the real navigation.
    prefetchedRoutes.delete(pathname);
  });
}
