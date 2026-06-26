import { createBrowserRouter } from "react-router-dom";
import PolicyConfigPage from "@/pages/PolicyConfigPage";
import SecurityMonitorPage from "@/pages/SecurityMonitorPage";

export const router = createBrowserRouter(
  [
    { path: "/", element: <SecurityMonitorPage /> },
    { path: "/admin/security-monitor", element: <SecurityMonitorPage /> },
    { path: "/admin/policy", element: <PolicyConfigPage /> },
  ],
  // Route under the configurable base path (e.g. `/apps/anysentry`) so client
  // routing works behind an ingress. Empty => `/` (local dev unaffected).
  { basename: import.meta.env.PUBLIC_BASE_PATH || "/" },
);
