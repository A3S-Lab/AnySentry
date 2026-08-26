import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router-dom";
import { SecurityAssistant } from "@/components/custom/security-assistant";
import { SecurityConsoleProvider } from "@/components/custom/security-console-header";
import { SecuritySidebar } from "@/components/custom/security-sidebar";
import AgentEventsPage from "@/pages/AgentEventsPage";
import AgentsPage from "@/pages/AgentsPage";
import AlertsPage from "@/pages/AlertsPage";
import AssetsPage from "@/pages/AssetsPage";
import AuditPage from "@/pages/AuditPage";
import CapabilitiesPage from "@/pages/CapabilitiesPage";
import CollectorsPage from "@/pages/CollectorsPage";
import FilterRulesPage from "@/pages/FilterRulesPage";
import CoveragePage from "@/pages/CoveragePage";
import EvidenceBundlePage from "@/pages/EvidenceBundlePage";
import IncidentsPage from "@/pages/IncidentsPage";
import MaintenancePage from "@/pages/MaintenancePage";
import NotificationsPage from "@/pages/NotificationsPage";
import ObjectivesPage from "@/pages/ObjectivesPage";
import OperatorPage from "@/pages/OperatorPage";
import PolicyConfigPage from "@/pages/PolicyConfigPage";
import RemediationPage from "@/pages/RemediationPage";
import SecurityMonitorPage from "@/pages/SecurityMonitorPage";
import SourcesPage from "@/pages/SourcesPage";
import TopologyPage from "@/pages/TopologyPage";
import WorkspacesPage from "@/pages/WorkspacesPage";

function AppShell() {
  return (
    <SecurityConsoleProvider>
      <div className="flex min-h-0 flex-1 overflow-hidden bg-[#0a0d12]">
        <SecuritySidebar />
        <div className="min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
        <SecurityAssistant />
      </div>
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
      { path: "/agents", element: <AgentsPage /> },
      { path: "/alerts", element: <AlertsPage /> },
      { path: "/assets", element: <AssetsPage /> },
      { path: "/assets/:assetId", element: <AssetsPage /> },
      { path: "/audit", element: <AuditPage /> },
      { path: "/capabilities", element: <CapabilitiesPage /> },
      { path: "/collectors", element: <CollectorsPage /> },
      { path: "/filter-rules", element: <FilterRulesPage /> },
      { path: "/capture-rules", element: <LegacyCaptureRulesRedirect /> },
      { path: "/coverage", element: <CoveragePage /> },
      { path: "/evidence", element: <EvidenceBundlePage /> },
      { path: "/events", element: <AgentEventsPage /> },
      { path: "/incidents", element: <IncidentsPage /> },
      { path: "/maintenance", element: <MaintenancePage /> },
      { path: "/notifications", element: <NotificationsPage /> },
      { path: "/objectives", element: <ObjectivesPage /> },
      { path: "/operator", element: <OperatorPage /> },
      { path: "/remediation", element: <RemediationPage /> },
      { path: "/sources", element: <SourcesPage /> },
      { path: "/topology", element: <TopologyPage /> },
      { path: "/workspaces", element: <WorkspacesPage /> },
      { path: "/admin/policy", element: <PolicyConfigPage /> },
    ],
  }],
  // Route under the configurable base path (e.g. `/apps/anysentry`) so client
  // routing works behind an ingress. Empty => `/` (local dev unaffected).
  { basename: __ANYSENTRY_BASE_PATH__ || "/" },
);
