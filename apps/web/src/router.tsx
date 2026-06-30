import { createBrowserRouter } from "react-router-dom";
import AgentEventsPage from "@/pages/AgentEventsPage";
import AgentsPage from "@/pages/AgentsPage";
import AlertsPage from "@/pages/AlertsPage";
import AuditPage from "@/pages/AuditPage";
import CollectorsPage from "@/pages/CollectorsPage";
import CoveragePage from "@/pages/CoveragePage";
import EvidenceBundlePage from "@/pages/EvidenceBundlePage";
import IncidentsPage from "@/pages/IncidentsPage";
import MaintenancePage from "@/pages/MaintenancePage";
import NotificationsPage from "@/pages/NotificationsPage";
import ObjectivesPage from "@/pages/ObjectivesPage";
import PolicyConfigPage from "@/pages/PolicyConfigPage";
import RemediationPage from "@/pages/RemediationPage";
import SecurityMonitorPage from "@/pages/SecurityMonitorPage";
import SourcesPage from "@/pages/SourcesPage";
import TopologyPage from "@/pages/TopologyPage";
import WorkspacesPage from "@/pages/WorkspacesPage";

export const router = createBrowserRouter(
  [
    { path: "/", element: <SecurityMonitorPage /> },
    { path: "/admin/security-monitor", element: <SecurityMonitorPage /> },
    { path: "/agents", element: <AgentsPage /> },
    { path: "/alerts", element: <AlertsPage /> },
    { path: "/audit", element: <AuditPage /> },
    { path: "/collectors", element: <CollectorsPage /> },
    { path: "/coverage", element: <CoveragePage /> },
    { path: "/evidence", element: <EvidenceBundlePage /> },
    { path: "/events", element: <AgentEventsPage /> },
    { path: "/incidents", element: <IncidentsPage /> },
    { path: "/maintenance", element: <MaintenancePage /> },
    { path: "/notifications", element: <NotificationsPage /> },
    { path: "/objectives", element: <ObjectivesPage /> },
    { path: "/remediation", element: <RemediationPage /> },
    { path: "/sources", element: <SourcesPage /> },
    { path: "/topology", element: <TopologyPage /> },
    { path: "/workspaces", element: <WorkspacesPage /> },
    { path: "/admin/policy", element: <PolicyConfigPage /> },
  ],
  // Route under the configurable base path (e.g. `/apps/anysentry`) so client
  // routing works behind an ingress. Empty => `/` (local dev unaffected).
  { basename: __ANYSENTRY_BASE_PATH__ || "/" },
);
