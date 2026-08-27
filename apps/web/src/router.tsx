import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router-dom";
import {
  SecurityAssistant,
  SecurityAssistantProvider,
} from "@/components/custom/security-assistant";
import { SecurityConsoleProvider } from "@/components/custom/security-console-header";
import { SecuritySidebar } from "@/components/custom/security-sidebar";
import SecurityMonitorPage from "@/pages/SecurityMonitorPage";
import { lazyRoute } from "@/lib/performance/route-loaders";

function AppShell() {
  return (
    <SecurityConsoleProvider>
      <SecurityAssistantProvider>
        <div className="flex min-h-0 flex-1 overflow-hidden bg-[#0a0d12]">
          <SecuritySidebar />
          <div className="min-w-0 flex-1 overflow-hidden">
            <Outlet />
          </div>
          <SecurityAssistant />
        </div>
      </SecurityAssistantProvider>
    </SecurityConsoleProvider>
  );
}

function LegacyCaptureRulesRedirect() {
  const location = useLocation();
  return <Navigate replace to={`/filter-rules${location.search}${location.hash}`} />;
}

export const router = createBrowserRouter(
  [{
    element: <AppShell />,
    children: [
      { path: "/", element: <SecurityMonitorPage /> },
      { path: "/admin/security-monitor", element: <SecurityMonitorPage /> },
      { path: "/ai/chat", lazy: lazyRoute("/ai/chat") },
      { path: "/agents", lazy: lazyRoute("/agents") },
      { path: "/alerts", lazy: lazyRoute("/alerts") },
      { path: "/assets", lazy: lazyRoute("/assets") },
      { path: "/assets/:assetId", lazy: lazyRoute("/assets") },
      { path: "/audit", lazy: lazyRoute("/audit") },
      { path: "/capabilities", lazy: lazyRoute("/capabilities") },
      { path: "/collectors", lazy: lazyRoute("/collectors") },
      { path: "/conversations", lazy: lazyRoute("/conversations") },
      { path: "/coverage", lazy: lazyRoute("/coverage") },
      { path: "/evidence", lazy: lazyRoute("/evidence") },
      { path: "/events", lazy: lazyRoute("/events") },
      { path: "/filter-rules", lazy: lazyRoute("/filter-rules") },
      { path: "/capture-rules", element: <LegacyCaptureRulesRedirect /> },
      { path: "/incidents", lazy: lazyRoute("/incidents") },
      { path: "/maintenance", lazy: lazyRoute("/maintenance") },
      { path: "/notifications", lazy: lazyRoute("/notifications") },
      { path: "/objectives", lazy: lazyRoute("/objectives") },
      { path: "/operator", lazy: lazyRoute("/operator") },
      { path: "/platform", lazy: lazyRoute("/platform") },
      { path: "/remediation", lazy: lazyRoute("/remediation") },
      { path: "/sources", lazy: lazyRoute("/sources") },
      { path: "/topology", lazy: lazyRoute("/topology") },
      { path: "/users", lazy: lazyRoute("/users") },
      { path: "/workspaces", lazy: lazyRoute("/workspaces") },
      { path: "/admin/policy", lazy: lazyRoute("/admin/policy") },
    ],
  }],
  // Route under the configurable base path (e.g. `/apps/anysentry`) so client
  // routing works behind an ingress. Empty => `/` (local dev unaffected).
  { basename: __ANYSENTRY_BASE_PATH__ || "/" },
);
