#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const apiBase = (process.env.ANYSENTRY_API_BASE ?? process.env.API_BASE ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`).replace(/\/$/, '');
const publicBasePath = normalizeBasePath(process.env.PUBLIC_BASE_PATH ?? '');
const defaultWebBase = `${new URL(apiBase).origin}${publicBasePath}`;
const webBase = (process.env.ANYSENTRY_WEB_BASE ?? process.env.WEB_BASE ?? defaultWebBase).replace(/\/$/, '');

const managementRoutes = [
  '/',
  '/admin/security-monitor',
  '/events?eventId=dashboard-smoke-missing',
  '/events?runId=dashboard-smoke-run',
  '/events?eventKind=ToolExec',
  '/agents?agentId=dashboard-smoke-agent&workspacePath=repo://dashboard-smoke',
  '/agents?userId=dashboard-smoke-user',
  '/workspaces?workspacePath=repo://dashboard-smoke',
  '/capabilities',
  '/capabilities?query=runtime%20guard',
  '/capabilities?action=search&query=runtime%20guard',
  '/capabilities?action=describe&module=security-center&operation=planNextActions',
  '/collectors?collectorId=dashboard-smoke-collector',
  '/sources?sourceId=dashboard-smoke-source',
  '/sources?sourceId=dashboard-smoke-source&collectorId=dashboard-smoke-collector&workspacePath=repo://dashboard-smoke',
  '/sources?collectorId=dashboard-smoke-collector&workspacePath=repo://dashboard-smoke',
  '/incidents?incidentId=dashboard-smoke-incident',
  '/alerts?alertId=dashboard-smoke-alert',
  '/alerts?incidentId=dashboard-smoke-incident',
  '/alerts?issueId=dashboard-smoke-coverage&sourceId=dashboard-smoke-source',
  '/alerts?timeType=last_3h&alertId=dashboard-smoke-alert&workspacePath=repo://dashboard-smoke&agentId=dashboard-smoke-agent',
  '/alerts?timeType=last_3h&kind=coverage&issueId=dashboard-smoke-coverage&sourceId=dashboard-smoke-source',
  '/alerts?timeType=last_3h&kind=objective&objectiveId=dashboard-smoke-objective&sourceId=dashboard-smoke-source',
  '/coverage?issueId=dashboard-smoke-coverage',
  '/coverage?agentId=dashboard-smoke-agent&workspacePath=repo://dashboard-smoke',
  '/coverage?collectorId=dashboard-smoke-collector',
  '/coverage?sourceId=dashboard-smoke-source',
  '/coverage?sourceId=dashboard-smoke-source&collectorId=dashboard-smoke-collector&workspacePath=repo://dashboard-smoke',
  '/evidence?auditId=dashboard-smoke-audit',
  '/evidence?edgeId=dashboard-smoke-edge',
  '/evidence?eventId=dashboard-smoke-event',
  '/evidence?objectiveId=dashboard-smoke-objective',
  '/evidence?issueId=dashboard-smoke-coverage',
  '/evidence?deliveryId=dashboard-smoke-delivery',
  '/evidence?windowId=dashboard-smoke-maintenance',
  '/evidence?timeType=last_3h&eventId=dashboard-smoke-event&agentId=dashboard-smoke-agent&workspacePath=repo://dashboard-smoke',
  '/evidence?timeType=last_3h&agentId=dashboard-smoke-agent&workspacePath=repo://dashboard-smoke',
  '/evidence?timeType=last_7d&windowId=dashboard-smoke-maintenance&agentId=dashboard-smoke-agent&workspacePath=repo://dashboard-smoke',
  '/evidence?timeType=last_3h&workspacePath=repo://dashboard-smoke',
  '/evidence?timeType=last_3h&collectorId=dashboard-smoke-collector',
  '/evidence?timeType=last_3h&sourceId=dashboard-smoke-source&collectorId=dashboard-smoke-collector&workspacePath=repo://dashboard-smoke',
  '/evidence?timeType=last_3h&objectiveId=dashboard-smoke-objective&sourceId=dashboard-smoke-source',
  '/evidence?timeType=last_3h&objectiveId=dashboard-smoke-objective&agentId=dashboard-smoke-agent&workspacePath=repo://dashboard-smoke',
  '/evidence?timeType=last_3h&issueId=dashboard-smoke-coverage&sourceId=dashboard-smoke-source',
  '/evidence?timeType=last_7d&sourceId=dashboard-smoke-source',
  '/evidence?timeType=last_30d&alertId=dashboard-smoke-alert&incidentId=dashboard-smoke-incident&eventId=dashboard-smoke-event&taskId=dashboard-smoke-task&objectiveId=dashboard-smoke-objective&issueId=dashboard-smoke-coverage&sourceId=dashboard-smoke-source',
  '/maintenance?windowId=dashboard-smoke-maintenance',
  '/maintenance?targetType=agent&targetId=repo://dashboard-smoke:dashboard-smoke-agent',
  '/maintenance?targetType=source&targetId=dashboard-smoke-source',
  '/remediation?taskId=dashboard-smoke-remediation',
  '/remediation?issueId=dashboard-smoke-coverage&sourceId=dashboard-smoke-source',
  '/remediation?timeType=last_7d&sourceId=dashboard-smoke-source&collectorId=dashboard-smoke-collector&workspacePath=repo://dashboard-smoke',
  '/remediation?timeType=last_3h&taskId=dashboard-smoke-remediation&workspacePath=repo://dashboard-smoke&agentId=dashboard-smoke-agent',
  '/remediation?timeType=last_3h&sourceType=coverage&issueId=dashboard-smoke-coverage&sourceId=dashboard-smoke-source',
  '/remediation?timeType=last_3h&objectiveId=dashboard-smoke-objective&sourceId=dashboard-smoke-source',
  '/operator',
  '/operator?timeType=last_3h&actionId=dashboard-smoke-action&taskId=dashboard-smoke-remediation&workspacePath=repo://dashboard-smoke&agentId=dashboard-smoke-agent',
  '/operator?timeType=last_3h&sourceType=coverage&issueId=dashboard-smoke-coverage&sourceId=dashboard-smoke-source&owner=dashboard-smoke-owner',
  '/notifications?sourceId=dashboard-smoke-source&kind=coverage&minSeverity=medium',
  '/notifications?channelId=dashboard-smoke-channel&routeId=dashboard-smoke-route&deliveryId=dashboard-smoke-delivery&alertId=dashboard-smoke-alert&incidentId=dashboard-smoke-incident&eventId=dashboard-smoke-event&taskId=dashboard-smoke-task&objectiveId=dashboard-smoke-objective&issueId=dashboard-smoke-coverage',
  '/objectives?objectiveId=dashboard-smoke-objective',
  '/objectives?targetType=source&targetId=dashboard-smoke-source&metric=source_down',
  '/objectives?targetType=agent&targetId=repo://dashboard-smoke:dashboard-smoke-agent&agentId=dashboard-smoke-agent&workspacePath=repo://dashboard-smoke&metric=active_alerts',
  '/audit?auditId=dashboard-smoke-audit',
  '/audit?action=notification.delivery_failed&resourceType=notification&resourceId=dashboard-smoke-delivery',
  '/audit?timeType=last_7d&resourceType=maintenance&resourceId=dashboard-smoke-maintenance',
  '/audit?timeType=last_7d&resourceType=source&resourceId=dashboard-smoke-source',
  '/topology?edgeId=dashboard-smoke-edge',
  '/topology?agentId=dashboard-smoke-agent&workspacePath=repo://dashboard-smoke',
  '/topology?collectorId=dashboard-smoke-collector',
  '/topology?sourceId=dashboard-smoke-source&collectorId=dashboard-smoke-collector&workspacePath=repo://dashboard-smoke',
  '/admin/policy',
];

function normalizeBasePath(raw) {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

function fail(message, details) {
  console.error(`FAIL ${message}`);
  if (details !== undefined) console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2));
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(message, condition, details) {
  if (condition) pass(message);
  else fail(message, details);
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function urlFor(path) {
  const base = new URL(webBase);
  const prefix = base.pathname.replace(/\/$/, '');
  const routePath = path.startsWith('/') ? path : `/${path}`;
  return new URL(`${prefix}${routePath}`, base.origin).toString();
}

async function fetchText(path) {
  const url = urlFor(path);
  const res = await fetch(url, { headers: { accept: 'text/html,*/*' } });
  const text = await res.text();
  return { url, res, text };
}

function isDashboardHtml(text) {
  return text.includes('<!DOCTYPE html') && text.includes('<div id="root"') && text.includes('/static/js/');
}

async function verifyIndexAndAssets() {
  const index = await fetchText('/');
  assert('dashboard root returns built SPA index', index.res.ok && isDashboardHtml(index.text), {
    url: index.url,
    status: index.res.status,
    preview: index.text.slice(0, 240),
  });

  const assetPaths = [...index.text.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]);
  const jsAssets = assetPaths.filter((asset) => asset.endsWith('.js'));
  const cssAssets = assetPaths.filter((asset) => asset.endsWith('.css'));
  assert('dashboard index references JavaScript and CSS assets', jsAssets.length >= 1 && cssAssets.length >= 1, assetPaths);

  const jsText = [];
  for (const asset of assetPaths) {
    const assetUrl = new URL(asset, `${webBase}/`).toString();
    const res = await fetch(assetUrl);
    const bytes = await res.arrayBuffer();
    const type = res.headers.get('content-type') ?? '';
    const expectedType = asset.endsWith('.js') ? 'javascript' : 'css';
    if (asset.endsWith('.js') && bytes.byteLength > 0) jsText.push(new TextDecoder().decode(bytes));
    assert(
      `dashboard asset is served: ${asset}`,
      res.ok && bytes.byteLength > 0 && type.toLowerCase().includes(expectedType),
      { assetUrl, status: res.status, contentType: type, bytes: bytes.byteLength },
    );
  }

  assert('dashboard HTML does not embed a dev API origin', !index.text.includes('127.0.0.1:29653') && !index.text.includes('localhost:29653'), index.text.slice(0, 500));
  const jsBundle = jsText.join('\n');
  assert('dashboard bundle supports browser-local management auth token', jsBundle.includes('anysentry.adminToken') && jsBundle.includes('X-AnySentry-Admin-Token'), { jsAssetCount: jsText.length });
  assert('dashboard bundle exposes management auth control UI', jsBundle.includes('管理密钥') && jsBundle.includes('控制面密钥'), { jsAssetCount: jsText.length });
  assert('dashboard bundle does not embed management auth secrets', !jsBundle.includes('verify-admin-token') && !jsBundle.includes('change-me-long-random-token'), { jsAssetCount: jsText.length });
  assert(
    'dashboard bundle exposes evidence bundle route and API client',
    jsBundle.includes('/evidence') &&
      jsBundle.includes('/security-center/evidence/bundle') &&
      jsBundle.includes('/security-center/evidence/export'),
    { jsAssetCount: jsText.length },
  );
  assert(
    'dashboard bundle exposes Coverage issue handoff actions',
    jsBundle.includes('/alerts?') &&
      jsBundle.includes('/remediation?') &&
      jsBundle.includes('sourceType') &&
      jsBundle.includes('issueId') &&
      jsBundle.includes('/security-center/coverage/overview'),
    { jsAssetCount: jsText.length },
  );
  assert(
    'dashboard bundle exposes cross-console evidence handoff actions',
    jsBundle.includes('/evidence?') &&
      jsBundle.includes('/alerts?') &&
      jsBundle.includes('/remediation?') &&
      jsBundle.includes('/audit?') &&
      jsBundle.includes('auditId') &&
      jsBundle.includes('edgeId') &&
      jsBundle.includes('objectiveId') &&
      jsBundle.includes('deliveryId') &&
      jsBundle.includes('windowId') &&
      jsBundle.includes('resourceType') &&
      jsBundle.includes('证据包'),
    { jsAssetCount: jsText.length },
  );
  assert(
    'dashboard bundle exposes AI Operator progressive next-action workbench',
    jsBundle.includes('/operator') &&
      jsBundle.includes('AI Operator') &&
      jsBundle.includes('planNextActions') &&
      jsBundle.includes('buildEvidenceBundle') &&
      jsBundle.includes('anysentry.progressive.next_action_plan.v1') &&
      jsBundle.includes('anysentry.evidence_bundle.v1') &&
      jsBundle.includes('/security-center/capabilities') &&
      jsBundle.includes('Next Actions') &&
      jsBundle.includes('预览证据') &&
      jsBundle.includes('/remediation?') &&
      jsBundle.includes('/evidence?'),
    { jsAssetCount: jsText.length },
  );
  assert(
    'dashboard bundle exposes Progressive API discovery workbench',
    jsBundle.includes('/capabilities') &&
      jsBundle.includes('Progressive API') &&
      jsBundle.includes('Discovery') &&
      jsBundle.includes('Input Schema') &&
      jsBundle.includes('securityCapabilities') &&
      jsBundle.includes('executeSecurityCapability') &&
      jsBundle.includes('Execute Request'),
    { jsAssetCount: jsText.length },
  );
  assert(
    'dashboard bundle exposes notification delivery Evidence repin action',
    jsBundle.includes('/evidence?') &&
      jsBundle.includes('deliveryId') &&
      jsBundle.includes('以此投递打开证据包'),
    { jsAssetCount: jsText.length },
  );
  assert(
    'dashboard bundle exposes maintenance window Evidence repin action',
    jsBundle.includes('/evidence?') &&
      jsBundle.includes('windowId') &&
      jsBundle.includes('以此维护窗口打开证据包'),
    { jsAssetCount: jsText.length },
  );
  assert(
    'dashboard bundle exposes audit record Evidence repin action',
    jsBundle.includes('/evidence?') &&
      jsBundle.includes('auditId') &&
      jsBundle.includes('以此审计记录打开证据包'),
    { jsAssetCount: jsText.length },
  );
  assert(
    'dashboard bundle exposes topology edge Evidence repin action',
    jsBundle.includes('/evidence?') &&
      jsBundle.includes('edgeId') &&
      jsBundle.includes('以此拓扑边打开证据包'),
    { jsAssetCount: jsText.length },
  );
}

async function verifyDashboardSourceContracts() {
  const agentEventsPage = await readFile('apps/web/src/pages/AgentEventsPage.tsx', 'utf8');
  const agentsPage = await readFile('apps/web/src/pages/AgentsPage.tsx', 'utf8');
  const alertingService = await readFile('apps/api/src/security-monitoring/alerting.service.ts', 'utf8');
  const alertsPage = await readFile('apps/web/src/pages/AlertsPage.tsx', 'utf8');
  const apiClient = await readFile('apps/web/src/lib/api/security-center.ts', 'utf8');
  const auditPage = await readFile('apps/web/src/pages/AuditPage.tsx', 'utf8');
  const capabilitiesPage = await readFile('apps/web/src/pages/CapabilitiesPage.tsx', 'utf8');
  const capabilityCurl = await readFile('apps/web/src/lib/api/security-capability-curl.ts', 'utf8');
  const coveragePage = await readFile('apps/web/src/pages/CoveragePage.tsx', 'utf8');
  const evidencePage = await readFile('apps/web/src/pages/EvidenceBundlePage.tsx', 'utf8');
  const maintenancePage = await readFile('apps/web/src/pages/MaintenancePage.tsx', 'utf8');
  const notificationsPage = await readFile('apps/web/src/pages/NotificationsPage.tsx', 'utf8');
  const objectivesPage = await readFile('apps/web/src/pages/ObjectivesPage.tsx', 'utf8');
  const objectiveService = await readFile('apps/api/src/security-monitoring/objective.service.ts', 'utf8');
  const operatorPage = await readFile('apps/web/src/pages/OperatorPage.tsx', 'utf8');
  const policyPage = await readFile('apps/web/src/pages/PolicyConfigPage.tsx', 'utf8');
  const remediationPage = await readFile('apps/web/src/pages/RemediationPage.tsx', 'utf8');
  const securityController = await readFile('apps/api/src/security-monitoring/security-monitoring.controller.ts', 'utf8');
  const securityMonitorPage = await readFile('apps/web/src/pages/SecurityMonitorPage.tsx', 'utf8');
  const sourcesPage = await readFile('apps/web/src/pages/SourcesPage.tsx', 'utf8');
  const topologyPage = await readFile('apps/web/src/pages/TopologyPage.tsx', 'utf8');
  const aggregationService = await readFile('apps/api/src/security-monitoring/aggregation.service.ts', 'utf8');
  const clickhouseStore = await readFile('apps/api/src/security-monitoring/clickhouse-store.ts', 'utf8');
  const objectiveServiceScope = {
    hasCompositeAgentTargetParser: objectiveService.includes('function splitAgentTargetId(targetId: string | undefined)'),
    hasScopedTargetDerivation:
      objectiveService.includes("const workspaceTarget = record.targetType === 'workspace' ? target : agentTarget.workspacePath") &&
      objectiveService.includes("const collectorTarget = record.targetType === 'collector' ? target : undefined") &&
      objectiveService.includes("const sourceTarget = record.targetType === 'source' ? target : undefined"),
    hasAgentFilterPushdown: countOccurrences(objectiveService, 'agentId: agentTarget.agentId') >= 5,
    hasWorkspaceFilterPushdown: countOccurrences(objectiveService, 'workspacePath: workspaceTarget') >= 5,
    hasCollectorFilterPushdown: countOccurrences(objectiveService, 'collectorId: collectorTarget') >= 5,
    hasSourceFilterPushdown: countOccurrences(objectiveService, 'sourceId: sourceTarget') >= 5,
    hasCollectorSourceStaleAgentScope:
      objectiveService.includes('const scopedAgentKeys = this.scopedAgentKeys(record, filter)') &&
      objectiveService.includes("collectorId: record.targetType === 'collector' ? record.targetId : undefined") &&
      objectiveService.includes("sourceId: record.targetType === 'source' ? record.targetId : undefined"),
  };
  assert(
    'dashboard Events deep links preserve run and event-kind selector scope',
    agentEventsPage.includes('const [runId, setRunId] = useState(searchParams.get("runId") ?? "")') &&
      agentEventsPage.includes('const [eventKind, setEventKind] = useState(searchParams.get("eventKind") ?? "")') &&
      agentEventsPage.includes('runId: clean(runId)') &&
      agentEventsPage.includes('eventKind: clean(eventKind)') &&
      agentEventsPage.includes('next.set("runId", event.runId)') &&
      agentEventsPage.includes('next.set("eventKind", event.eventKind)'),
    {
      hasRouteRunId: agentEventsPage.includes('const [runId, setRunId] = useState(searchParams.get("runId") ?? "")'),
      hasRouteEventKind: agentEventsPage.includes('const [eventKind, setEventKind] = useState(searchParams.get("eventKind") ?? "")'),
      hasQueryRunId: agentEventsPage.includes('runId: clean(runId)'),
      hasQueryEventKind: agentEventsPage.includes('eventKind: clean(eventKind)'),
      hasSelectedRunId: agentEventsPage.includes('next.set("runId", event.runId)'),
      hasSelectedEventKind: agentEventsPage.includes('next.set("eventKind", event.eventKind)'),
    },
  );
  assert(
    'dashboard Event handoffs preserve selected source and collector scope',
    agentEventsPage.includes('const eventSourceId = event.sourceId ?? (typeof event.attributes.sourceId === "string" ? event.attributes.sourceId : undefined)') &&
      agentEventsPage.includes('const eventCollectorId = event.collectorId ?? (typeof event.attributes.collectorId === "string" ? event.attributes.collectorId : undefined)') &&
      agentEventsPage.includes('if (eventSourceId) topologyQs.set("sourceId", eventSourceId)') &&
      agentEventsPage.includes('if (eventCollectorId) topologyQs.set("collectorId", eventCollectorId)') &&
      agentEventsPage.includes('if (eventSourceId) evidenceQs.set("sourceId", eventSourceId)') &&
      agentEventsPage.includes('if (eventCollectorId) evidenceQs.set("collectorId", eventCollectorId)') &&
      agentEventsPage.includes('if (eventSourceId ?? sourceId) next.set("sourceId", eventSourceId ?? sourceId)') &&
      agentEventsPage.includes('if (eventCollectorId ?? collectorId) next.set("collectorId", eventCollectorId ?? collectorId)'),
    {
      hasEventSourceFallback: agentEventsPage.includes('const eventSourceId = event.sourceId ?? (typeof event.attributes.sourceId === "string" ? event.attributes.sourceId : undefined)'),
      hasEventCollectorFallback: agentEventsPage.includes('const eventCollectorId = event.collectorId ?? (typeof event.attributes.collectorId === "string" ? event.attributes.collectorId : undefined)'),
      hasTopologySource: agentEventsPage.includes('if (eventSourceId) topologyQs.set("sourceId", eventSourceId)'),
      hasTopologyCollector: agentEventsPage.includes('if (eventCollectorId) topologyQs.set("collectorId", eventCollectorId)'),
      hasEvidenceSource: agentEventsPage.includes('if (eventSourceId) evidenceQs.set("sourceId", eventSourceId)'),
      hasEvidenceCollector: agentEventsPage.includes('if (eventCollectorId) evidenceQs.set("collectorId", eventCollectorId)'),
    },
  );
  assert(
    'backend event scopes read promoted source and collector IDs before attribute fallback',
    aggregationService.includes('function eventCollectorId(e: T.JudgedEvent): string') &&
      aggregationService.includes("return e.collectorId?.trim() || attrString(e, 'collectorId')") &&
      aggregationService.includes('function eventSourceId(e: T.JudgedEvent): string') &&
      aggregationService.includes("return e.sourceId?.trim() || attrString(e, 'sourceId')") &&
      aggregationService.includes('(!sourceId || eventSource === sourceId)') &&
      aggregationService.includes('(!collectorId || eventCollector === collectorId)') &&
      aggregationService.includes('const collectorRef = eventCollectorId(e)') &&
      aggregationService.includes('const sourceRef = eventSourceId(e)') &&
      securityController.includes("function evidenceEventCollectorId(event: Pick<T.AgentEventListItem, 'collectorId' | 'sourceId' | 'attributes'> | undefined): string | undefined") &&
      securityController.includes("return selector(event?.collectorId, 180) ?? evidenceAttrText(event?.attributes, 'collectorId')") &&
      securityController.includes("function evidenceEventSourceId(event: Pick<T.AgentEventListItem, 'collectorId' | 'sourceId' | 'attributes'> | undefined): string | undefined") &&
      securityController.includes("return selector(event?.sourceId, 160) ?? evidenceAttrText(event?.attributes, 'sourceId')") &&
      securityController.includes('evidenceEventSourceId(event)') &&
      securityController.includes('evidenceEventCollectorId(event)'),
    {
      hasCollectorHelper: aggregationService.includes('function eventCollectorId(e: T.JudgedEvent): string'),
      hasSourceHelper: aggregationService.includes('function eventSourceId(e: T.JudgedEvent): string'),
      hasFilterHelpers: aggregationService.includes('(!sourceId || eventSource === sourceId)') && aggregationService.includes('(!collectorId || eventCollector === collectorId)'),
      hasTopologyHelpers: aggregationService.includes('const collectorRef = eventCollectorId(e)') && aggregationService.includes('const sourceRef = eventSourceId(e)'),
      hasEvidenceBundlePromotedScope:
        securityController.includes("function evidenceEventCollectorId(event: Pick<T.AgentEventListItem, 'collectorId' | 'sourceId' | 'attributes'> | undefined): string | undefined") &&
        securityController.includes("function evidenceEventSourceId(event: Pick<T.AgentEventListItem, 'collectorId' | 'sourceId' | 'attributes'> | undefined): string | undefined") &&
        securityController.includes('evidenceEventSourceId(event)') &&
        securityController.includes('evidenceEventCollectorId(event)'),
    },
  );
  assert(
    'ClickHouse event store persists promoted source and collector IDs',
    clickhouseStore.includes('collectorId String') &&
      clickhouseStore.includes('sourceId String') &&
      clickhouseStore.includes('ADD COLUMN IF NOT EXISTS collectorId String DEFAULT') &&
      clickhouseStore.includes('ADD COLUMN IF NOT EXISTS sourceId String DEFAULT') &&
      clickhouseStore.includes("collectorId: e.collectorId?.trim() || attrString(e.attributes, 'collectorId')") &&
      clickhouseStore.includes("sourceId: e.sourceId?.trim() || attrString(e.attributes, 'sourceId')") &&
      clickhouseStore.includes("const collectorId = str(r.collectorId) || attrString(attributes, 'collectorId') || undefined") &&
      clickhouseStore.includes("const sourceId = str(r.sourceId) || attrString(attributes, 'sourceId') || undefined"),
    {
      hasColumns: clickhouseStore.includes('collectorId String') && clickhouseStore.includes('sourceId String'),
      hasAlters: clickhouseStore.includes('ADD COLUMN IF NOT EXISTS collectorId String DEFAULT') && clickhouseStore.includes('ADD COLUMN IF NOT EXISTS sourceId String DEFAULT'),
      hasWrite: clickhouseStore.includes("collectorId: e.collectorId?.trim() || attrString(e.attributes, 'collectorId')"),
      hasHydrate: clickhouseStore.includes("const collectorId = str(r.collectorId) || attrString(attributes, 'collectorId') || undefined"),
    },
  );
  assert(
    'dashboard Agents deep links preserve user selector scope',
    agentsPage.includes('const [userId, setUserId] = useState(searchParams.get("userId") ?? "")') &&
      agentsPage.includes('userId: clean(userId)') &&
      agentsPage.includes('if (clean(userId)) next.set("userId", userId.trim())'),
    {
      hasRouteUserId: agentsPage.includes('const [userId, setUserId] = useState(searchParams.get("userId") ?? "")'),
      hasQueryUserId: agentsPage.includes('userId: clean(userId)'),
      hasSelectedUserId: agentsPage.includes('if (clean(userId)) next.set("userId", userId.trim())'),
    },
  );
  assert(
    'dashboard API client exposes read-only Agent metadata inventory endpoint',
    securityController.includes("@Get('agents/metadata')") &&
      agentsPage.includes('securityCenterApi.updateAgentMetadata') &&
      apiClient.includes('agentMetadata: () => apiClient.get<AgentMetadataList>("/security-center/agents/metadata")'),
    {
      hasBackendRoute: securityController.includes("@Get('agents/metadata')"),
      hasMetadataUpdateUi: agentsPage.includes('securityCenterApi.updateAgentMetadata'),
    },
  );
  assert(
    'dashboard AI Operator uses progressive planning, progressive evidence, and shared handoffs',
    operatorPage.includes('securityCenterApi.nextActionPlan(params)') &&
      operatorPage.includes('securityCenterApi.evidenceBundleCapability(evidenceBundleParams(action.evidence.bundleHint, action, timeType))') &&
      operatorPage.includes('securityCenterApi.updateRemediation(action.taskId, { status: nextStatus })') &&
      operatorPage.includes('schemaVersion === "anysentry.progressive.next_action_plan.v1"') &&
      operatorPage.includes('schemaVersion === "anysentry.evidence_bundle.v1"') &&
      operatorPage.includes('evidenceQuery(action.evidence.bundleHint, action, timeType)') &&
      operatorPage.includes('remediationQuery(action, timeType)') &&
      operatorPage.includes('generatedSecurityCapabilityCurl(planRequest)') &&
      operatorPage.includes('Canonical planNextActions curl') &&
      operatorPage.includes('const copyPlanCurl = async () =>') &&
      operatorPage.includes('navigator.clipboard?.writeText(planCurl)') &&
      operatorPage.includes('function operatorRouteParams({') &&
      operatorPage.includes('const routeText = searchParams.toString()') &&
      operatorPage.includes('setSearchParams(next, { replace: true })') &&
      operatorPage.includes('setSearchParams(operatorRouteParams({') &&
      operatorPage.includes('<Link to="/remediation">') &&
      apiClient.includes('nextActionPlan: (params: SecurityNextActionPlanParams') &&
      apiClient.includes('operation: "planNextActions"') &&
      apiClient.includes('evidenceBundleCapability: (params: EvidenceBundleQuery') &&
      apiClient.includes('operation: "buildEvidenceBundle"') &&
      securityController.includes("operation.name === 'planNextActions'") &&
      securityController.includes("operation.name === 'buildEvidenceBundle'") &&
      securityMonitorPage.includes('<Link to="/operator">'),
    {
      hasProgressiveApiCall: operatorPage.includes('securityCenterApi.nextActionPlan(params)'),
      hasProgressiveEvidenceCall: operatorPage.includes('securityCenterApi.evidenceBundleCapability(evidenceBundleParams(action.evidence.bundleHint, action, timeType))'),
      hasRemediationMutation: operatorPage.includes('securityCenterApi.updateRemediation(action.taskId, { status: nextStatus })'),
      hasPlanSchemaGuard: operatorPage.includes('schemaVersion === "anysentry.progressive.next_action_plan.v1"'),
      hasEvidenceSchemaGuard: operatorPage.includes('schemaVersion === "anysentry.evidence_bundle.v1"'),
      hasEvidenceHandoff: operatorPage.includes('evidenceQuery(action.evidence.bundleHint, action, timeType)'),
      hasRemediationHandoff: operatorPage.includes('remediationQuery(action, timeType)'),
      hasCanonicalPlanCurl:
        operatorPage.includes('generatedSecurityCapabilityCurl(planRequest)') &&
        operatorPage.includes('Canonical planNextActions curl') &&
        operatorPage.includes('const copyPlanCurl = async () =>') &&
        operatorPage.includes('navigator.clipboard?.writeText(planCurl)'),
      hasUrlBackedOperatorState:
        operatorPage.includes('function operatorRouteParams({') &&
        operatorPage.includes('const routeText = searchParams.toString()') &&
        operatorPage.includes('setSearchParams(next, { replace: true })') &&
        operatorPage.includes('setSearchParams(operatorRouteParams({'),
      hasDashboardEntry: securityMonitorPage.includes('<Link to="/operator">'),
    },
  );
  assert(
    'dashboard Progressive API workbench follows discover-first source-compatible flow',
    capabilitiesPage.includes('securityCenterApi.securityCapabilities({ action: "list" })') &&
      capabilitiesPage.includes('securityCenterApi.securityCapabilities({ action: "search", query: nextQuery })') &&
      capabilitiesPage.includes('securityCenterApi.securityCapabilities({ action: "describe", module: moduleName, operation: operationName })') &&
      capabilitiesPage.includes('securityCenterApi.executeSecurityCapability(parsed)') &&
      capabilitiesPage.includes('const dryRun = async () =>') &&
      capabilitiesPage.includes('securityCenterApi.executeSecurityCapability({ ...parsed, dryRun: true })') &&
      capabilitiesPage.includes('onClick={dryRun}') &&
      capabilitiesPage.includes('function asDryRunResult(value: unknown)') &&
      capabilitiesPage.includes('schemaVersion === "anysentry.progressive.dry_run.v1"') &&
      capabilitiesPage.includes('function DryRunSummary({ result }') &&
      capabilitiesPage.includes('Backend Preflight') &&
      capabilitiesPage.includes('<DryRunSummary result={dryRunResult} />') &&
      capabilitiesPage.includes('operationExamples(selectedOperation)') &&
      capabilitiesPage.includes('operationPayload(selectedOperation, example)') &&
      capabilitiesPage.includes('validateAgainstSchema(bodySchema, parsed)') &&
      capabilitiesPage.includes('requestValidationIssues(requestText, selectedOperation)') &&
      capabilitiesPage.includes('disabled={loading || validationErrors.length > 0}') &&
      capabilityCurl.includes('function shellQuote(value: string)') &&
      capabilityCurl.includes('export function securityCapabilitiesEndpoint()') &&
      capabilityCurl.includes('export function generatedSecurityCapabilityCurl(request: string | unknown)') &&
      capabilityCurl.includes('curl -fsS -X POST') &&
      capabilityCurl.includes('/security-center/capabilities') &&
      capabilitiesPage.includes('generatedSecurityCapabilityCurl(requestText)') &&
      capabilitiesPage.includes('Canonical curl') &&
      capabilitiesPage.includes('const copyCanonicalCurl = async () =>') &&
      capabilitiesPage.includes('navigator.clipboard?.writeText(curlText)') &&
      capabilitiesPage.includes('const [searchParams, setSearchParams] = useSearchParams()') &&
      capabilitiesPage.includes('const routeAction = capabilityRouteAction(searchParams.get("action"))') &&
      capabilitiesPage.includes('const [query, setQuery] = useState(routeQuery)') &&
      capabilitiesPage.includes('capabilityRouteParams({ action: "search", query: nextQuery, module: "security-center", operation: firstOperation.name })') &&
      capabilitiesPage.includes('capabilityRouteParams({ action: options.action ?? "describe"') &&
      capabilitiesPage.includes('void refreshModules(routeModule, routeOperation, false, routeAction)') &&
      !capabilitiesPage.includes('const SAMPLE_PARAMS') &&
      capabilitiesPage.includes('schemaConstString(bodyProperties.action, "execute")') &&
      capabilitiesPage.includes('schemaConstString(bodyProperties.module, "security-center")') &&
      securityMonitorPage.includes('<Link to="/capabilities">'),
    {
      hasList: capabilitiesPage.includes('securityCenterApi.securityCapabilities({ action: "list" })'),
      hasSearch: capabilitiesPage.includes('securityCenterApi.securityCapabilities({ action: "search", query: nextQuery })'),
      hasDescribe: capabilitiesPage.includes('securityCenterApi.securityCapabilities({ action: "describe", module: moduleName, operation: operationName })'),
      hasExecute: capabilitiesPage.includes('securityCenterApi.executeSecurityCapability(parsed)'),
      hasDryRunPreflight:
        capabilitiesPage.includes('const dryRun = async () =>') &&
        capabilitiesPage.includes('securityCenterApi.executeSecurityCapability({ ...parsed, dryRun: true })') &&
        capabilitiesPage.includes('onClick={dryRun}'),
      hasBackendPreflightSummary:
        capabilitiesPage.includes('function asDryRunResult(value: unknown)') &&
        capabilitiesPage.includes('schemaVersion === "anysentry.progressive.dry_run.v1"') &&
        capabilitiesPage.includes('function DryRunSummary({ result }') &&
        capabilitiesPage.includes('Backend Preflight') &&
        capabilitiesPage.includes('<DryRunSummary result={dryRunResult} />'),
      hasCanonicalExamples:
        capabilitiesPage.includes('operationExamples(selectedOperation)') && capabilitiesPage.includes('operationPayload(selectedOperation, example)'),
      hasSchemaValidation:
        capabilitiesPage.includes('validateAgainstSchema(bodySchema, parsed)') &&
        capabilitiesPage.includes('requestValidationIssues(requestText, selectedOperation)') &&
        capabilitiesPage.includes('disabled={loading || validationErrors.length > 0}'),
      hasGeneratedCurl:
        capabilityCurl.includes('function shellQuote(value: string)') &&
        capabilityCurl.includes('export function securityCapabilitiesEndpoint()') &&
        capabilityCurl.includes('export function generatedSecurityCapabilityCurl(request: string | unknown)') &&
        capabilityCurl.includes('curl -fsS -X POST') &&
        capabilityCurl.includes('/security-center/capabilities') &&
        capabilitiesPage.includes('generatedSecurityCapabilityCurl(requestText)') &&
        capabilitiesPage.includes('Canonical curl') &&
        capabilitiesPage.includes('const copyCanonicalCurl = async () =>') &&
        capabilitiesPage.includes('navigator.clipboard?.writeText(curlText)'),
      hasNoHardcodedSamples: !capabilitiesPage.includes('const SAMPLE_PARAMS'),
      hasSchemaDrivenEnvelope:
        capabilitiesPage.includes('schemaConstString(bodyProperties.action, "execute")') &&
        capabilitiesPage.includes('schemaConstString(bodyProperties.module, "security-center")'),
      hasUrlBackedState:
        capabilitiesPage.includes('const [searchParams, setSearchParams] = useSearchParams()') &&
        capabilitiesPage.includes('const routeAction = capabilityRouteAction(searchParams.get("action"))') &&
        capabilitiesPage.includes('const [query, setQuery] = useState(routeQuery)') &&
        capabilitiesPage.includes('void refreshModules(routeModule, routeOperation, false, routeAction)'),
      hasDashboardEntry: securityMonitorPage.includes('<Link to="/capabilities">'),
    },
  );
  assert(
    'dashboard mounts live Agent observability SSE stream',
    securityController.includes("@Sse('sessions/agentObservability/stream')") &&
      securityController.includes('@SkipWrap()') &&
      apiClient.includes('export function streamAgentObservability') &&
      apiClient.includes('Accept: "text/event-stream"') &&
      securityMonitorPage.includes('streamAgentObservability(') &&
      securityMonitorPage.includes('<LiveObservabilityPanel observability={observability} connected={observabilityConnected} />'),
    {
      hasBackendSse: securityController.includes("@Sse('sessions/agentObservability/stream')"),
      hasSkipWrap: securityController.includes('@SkipWrap()'),
      hasClientStream: apiClient.includes('export function streamAgentObservability') && apiClient.includes('Accept: "text/event-stream"'),
      hasDashboardPanel: securityMonitorPage.includes('<LiveObservabilityPanel observability={observability} connected={observabilityConnected} />'),
    },
  );
  assert(
    'dashboard Alerts deep links preserve incident selector scope',
    alertsPage.includes('const routeIncidentId = searchParams.get("incidentId") ?? ""') &&
      alertsPage.includes('incidentId: clean(routeIncidentId)') &&
      alertsPage.includes('if (alert.incidentId) next.set("incidentId", alert.incidentId)'),
    {
      hasRouteIncidentId: alertsPage.includes('const routeIncidentId = searchParams.get("incidentId") ?? ""'),
      hasQueryIncidentId: alertsPage.includes('incidentId: clean(routeIncidentId)'),
      hasSelectedIncidentId: alertsPage.includes('if (alert.incidentId) next.set("incidentId", alert.incidentId)'),
    },
  );
  assert(
    'dashboard Alert handoffs preserve workspace selector scope',
    alertsPage.includes('if (alert.workspacePath) eventQs.set("workspacePath", alert.workspacePath)') &&
      alertsPage.includes('if (alert.workspacePath) incidentQs.set("workspacePath", alert.workspacePath)') &&
      alertsPage.includes('if (alert.workspacePath) agentQs.set("workspacePath", alert.workspacePath)') &&
      alertsPage.includes('<FieldValue label="Workspace" value={alert.workspacePath} />') &&
      alertsPage.includes('if (alert.workspacePath) next.set("workspacePath", alert.workspacePath)') &&
      evidencePage.includes('workspacePath: alert.workspacePath') &&
      notificationsPage.includes('if (item.workspacePath) params.set("workspacePath", item.workspacePath)'),
    {
      alertsPage: {
        hasEventWorkspace: alertsPage.includes('if (alert.workspacePath) eventQs.set("workspacePath", alert.workspacePath)'),
        hasIncidentWorkspace: alertsPage.includes('if (alert.workspacePath) incidentQs.set("workspacePath", alert.workspacePath)'),
        hasAgentWorkspace: alertsPage.includes('if (alert.workspacePath) agentQs.set("workspacePath", alert.workspacePath)'),
        hasWorkspaceField: alertsPage.includes('<FieldValue label="Workspace" value={alert.workspacePath} />'),
        hasSelectedWorkspace: alertsPage.includes('if (alert.workspacePath) next.set("workspacePath", alert.workspacePath)'),
      },
      evidencePage: {
        hasAlertWorkspaceScope: evidencePage.includes('workspacePath: alert.workspacePath'),
      },
      notificationsPage: {
        hasAlertWorkspaceScope: notificationsPage.includes('if (item.workspacePath) params.set("workspacePath", item.workspacePath)'),
      },
    },
  );
  assert(
    'dashboard Remediation handoffs preserve workspace selector scope',
    remediationPage.includes('if (task.workspacePath) eventQs.set("workspacePath", task.workspacePath)') &&
      remediationPage.includes('if (task.workspacePath) incidentQs.set("workspacePath", task.workspacePath)') &&
      remediationPage.includes('if (task.workspacePath) alertQs.set("workspacePath", task.workspacePath)') &&
      remediationPage.includes('if (task.workspacePath) next.set("workspacePath", task.workspacePath)'),
    {
      hasEventWorkspace: remediationPage.includes('if (task.workspacePath) eventQs.set("workspacePath", task.workspacePath)'),
      hasIncidentWorkspace: remediationPage.includes('if (task.workspacePath) incidentQs.set("workspacePath", task.workspacePath)'),
      hasAlertWorkspace: remediationPage.includes('if (task.workspacePath) alertQs.set("workspacePath", task.workspacePath)'),
      hasSelectedWorkspace: remediationPage.includes('if (task.workspacePath) next.set("workspacePath", task.workspacePath)'),
    },
  );
  assert(
    'dashboard event drill-downs preserve workspace selector scope',
    coveragePage.includes('if (issue.workspacePath) eventQs.set("workspacePath", issue.workspacePath)') &&
      coveragePage.includes('if (issue.sourceId) eventQs.set("sourceId", issue.sourceId)') &&
      policyPage.includes('eventQs.set("workspacePath", diff.workspacePath)') &&
      topologyPage.includes('const edgeWorkspacePath = source?.workspacePath ?? target?.workspacePath ?? routeWorkspacePath') &&
      topologyPage.includes('if (edgeWorkspacePath) eventQs.set("workspacePath", edgeWorkspacePath)') &&
      topologyPage.includes('if (edgeCollectorId) eventQs.set("collectorId", edgeCollectorId)'),
    {
      coveragePage: {
        hasCoverageWorkspace: coveragePage.includes('if (issue.workspacePath) eventQs.set("workspacePath", issue.workspacePath)'),
        hasCoverageSource: coveragePage.includes('if (issue.sourceId) eventQs.set("sourceId", issue.sourceId)'),
      },
      policyPage: {
        hasPolicyWorkspace: policyPage.includes('eventQs.set("workspacePath", diff.workspacePath)'),
      },
      topologyPage: {
        hasTopologyWorkspace: topologyPage.includes('const edgeWorkspacePath = source?.workspacePath ?? target?.workspacePath ?? routeWorkspacePath') && topologyPage.includes('if (edgeWorkspacePath) eventQs.set("workspacePath", edgeWorkspacePath)'),
        hasTopologyCollector: topologyPage.includes('if (edgeCollectorId) eventQs.set("collectorId", edgeCollectorId)'),
      },
    },
  );
  assert(
    'dashboard Source handoffs preserve collector and workspace selector scope',
    sourcesPage.includes(`function sourceEventsHref(source: IngestionSourceItem) {
  const params = new URLSearchParams({ timeType: "last_3h", sourceId: source.sourceId });
  if (source.collectorId) params.set("collectorId", source.collectorId);
  if (source.workspacePath) params.set("workspacePath", source.workspacePath);`) &&
      sourcesPage.includes(`function sourceAlertsHref(source: IngestionSourceItem) {
  const params = new URLSearchParams({ timeType: "last_3h", status: "all", kind: "source", sourceId: source.sourceId });
  if (source.collectorId) params.set("collectorId", source.collectorId);
  if (source.workspacePath) params.set("workspacePath", source.workspacePath);`) &&
      sourcesPage.includes(`function sourceCoverageHref(source: IngestionSourceItem) {
  const params = new URLSearchParams({ timeType: "last_7d", sourceId: source.sourceId });
  if (source.collectorId) params.set("collectorId", source.collectorId);
  if (source.workspacePath) params.set("workspacePath", source.workspacePath);`) &&
      sourcesPage.includes(`function sourceRemediationHref(source: IngestionSourceItem) {
  const params = new URLSearchParams({ timeType: "last_7d", sourceId: source.sourceId });
  if (source.collectorId) params.set("collectorId", source.collectorId);
  if (source.workspacePath) params.set("workspacePath", source.workspacePath);`) &&
      remediationPage.includes('if (task.collectorId) sourceQs.set("collectorId", task.collectorId)') &&
      remediationPage.includes('if (task.workspacePath) sourceQs.set("workspacePath", task.workspacePath)') &&
      evidencePage.includes('sourceId: source.sourceId, collectorId: source.collectorId, workspacePath: source.workspacePath'),
    {
      sourcesPage: {
        hasSourceEventsScope: sourcesPage.includes(`function sourceEventsHref(source: IngestionSourceItem) {
  const params = new URLSearchParams({ timeType: "last_3h", sourceId: source.sourceId });
  if (source.collectorId) params.set("collectorId", source.collectorId);
  if (source.workspacePath) params.set("workspacePath", source.workspacePath);`),
        hasSourceAlertsScope: sourcesPage.includes(`function sourceAlertsHref(source: IngestionSourceItem) {
  const params = new URLSearchParams({ timeType: "last_3h", status: "all", kind: "source", sourceId: source.sourceId });
  if (source.collectorId) params.set("collectorId", source.collectorId);
  if (source.workspacePath) params.set("workspacePath", source.workspacePath);`),
        hasSourceCoverageScope: sourcesPage.includes(`function sourceCoverageHref(source: IngestionSourceItem) {
  const params = new URLSearchParams({ timeType: "last_7d", sourceId: source.sourceId });
  if (source.collectorId) params.set("collectorId", source.collectorId);
  if (source.workspacePath) params.set("workspacePath", source.workspacePath);`),
        hasSourceRemediationScope: sourcesPage.includes(`function sourceRemediationHref(source: IngestionSourceItem) {
  const params = new URLSearchParams({ timeType: "last_7d", sourceId: source.sourceId });
  if (source.collectorId) params.set("collectorId", source.collectorId);
  if (source.workspacePath) params.set("workspacePath", source.workspacePath);`),
      },
      remediationPage: {
        hasSourceCollectorScope: remediationPage.includes('if (task.collectorId) sourceQs.set("collectorId", task.collectorId)'),
        hasSourceWorkspaceScope: remediationPage.includes('if (task.workspacePath) sourceQs.set("workspacePath", task.workspacePath)'),
      },
      evidencePage: {
        hasSourceContextHref: evidencePage.includes('sourceId: source.sourceId, collectorId: source.collectorId, workspacePath: source.workspacePath'),
      },
    },
  );
  assert(
    'dashboard Source console exposes short OTEL mixed ingest smoke path',
    sourcesPage.includes('"otel_mixed"') &&
      sourcesPage.includes('{ value: "otel_mixed", label: "OTel Mixed" }') &&
      sourcesPage.includes('securityCenterApi.ingestOtel(buildOtelMixedPayload(selected, draft, token))') &&
      sourcesPage.includes('function buildOtelMixedSnippet') &&
      sourcesPage.includes('http://localhost:29653/security-center/ingest/otel') &&
      sourcesPage.includes('resourceLogs: logs.resourceLogs') &&
      sourcesPage.includes('resourceSpans: traces.resourceSpans'),
    {
      hasOption: sourcesPage.includes('{ value: "otel_mixed", label: "OTel Mixed" }'),
      hasShortEndpointCall: sourcesPage.includes('securityCenterApi.ingestOtel(buildOtelMixedPayload(selected, draft, token))'),
      hasMixedSnippet: sourcesPage.includes('function buildOtelMixedSnippet') && sourcesPage.includes('http://localhost:29653/security-center/ingest/otel'),
      hasMixedSignals: sourcesPage.includes('resourceLogs: logs.resourceLogs') && sourcesPage.includes('resourceSpans: traces.resourceSpans'),
    },
  );
  assert(
    'dashboard Objective handoffs preserve composite agent and target selector scope',
    agentsPage.includes('targetId: `${agent.workspacePath}:${agent.agentId}`') &&
      agentsPage.includes('agentId: agent.agentId, workspacePath: agent.workspacePath') &&
      objectivesPage.includes('function targetIdFromParams(params: URLSearchParams, targetType: ObjectiveTargetType | undefined)') &&
      objectivesPage.includes('const agentId = params.get("agentId") ?? ""') &&
      objectivesPage.includes('return agentId && workspacePath ? `${workspacePath}:${agentId}` : agentId') &&
      objectivesPage.includes('function addObjectiveTargetParams(params: URLSearchParams, item: ObjectiveItem)') &&
      objectivesPage.includes('const scope = splitAgentTargetId(targetId)') &&
      objectivesPage.includes('params.set("agentId", scope.agentId)') &&
      objectivesPage.includes('if (scope.workspacePath) params.set("workspacePath", scope.workspacePath)') &&
      objectivesPage.includes('function objectiveTargetHref(item: ObjectiveItem)') &&
      objectivesPage.includes('function objectiveCoverageHref(item: ObjectiveItem, timeType: SecurityTimeType)') &&
      objectivesPage.includes('function objectiveMaintenanceHref(item: ObjectiveItem, timeType: SecurityTimeType)') &&
      objectivesPage.includes('function objectiveNotificationHref(item: ObjectiveItem)') &&
      evidencePage.includes('function objectiveTargetScope(objective: ObjectiveItem)') &&
      evidencePage.includes('if (objective.targetType === "agent") return splitAgentTargetId(targetId)') &&
      evidencePage.includes('agentId: scope.agentId') &&
      evidencePage.includes('workspacePath: scope.workspacePath') &&
      securityController.includes('const objectiveAgentScope = objective?.targetType === \'agent\' ? splitAgentTargetId(objective.targetId) : {}') &&
      securityController.includes('objectiveAgentScope.workspacePath') &&
      alertingService.includes('const agentTarget = objective.targetType === \'agent\' ? splitAgentTargetId(objective.targetId) : {}') &&
      alertingService.includes('const workspacePath = objective.targetType === \'workspace\' ? objective.targetId : agentTarget.workspacePath') &&
      objectiveService.includes('function splitAgentTargetId(targetId: string | undefined)') &&
      objectiveServiceScope.hasScopedTargetDerivation &&
      objectiveServiceScope.hasAgentFilterPushdown &&
      objectiveServiceScope.hasWorkspaceFilterPushdown &&
      objectiveServiceScope.hasCollectorFilterPushdown &&
      objectiveServiceScope.hasSourceFilterPushdown &&
      objectiveServiceScope.hasCollectorSourceStaleAgentScope,
    {
      agentsPage: {
        hasCompositeAgentObjectiveTarget: agentsPage.includes('targetId: `${agent.workspacePath}:${agent.agentId}`'),
        hasAgentObjectiveScopeParams: agentsPage.includes('agentId: agent.agentId, workspacePath: agent.workspacePath'),
      },
      objectivesPage: {
        hasRouteScopeParser: objectivesPage.includes('function targetIdFromParams(params: URLSearchParams, targetType: ObjectiveTargetType | undefined)'),
        hasAgentRouteScope: objectivesPage.includes('const agentId = params.get("agentId") ?? ""') && objectivesPage.includes('return agentId && workspacePath ? `${workspacePath}:${agentId}` : agentId'),
        hasTargetScopeHelper: objectivesPage.includes('function addObjectiveTargetParams(params: URLSearchParams, item: ObjectiveItem)'),
        hasCrossConsoleHrefs: objectivesPage.includes('function objectiveTargetHref(item: ObjectiveItem)') && objectivesPage.includes('function objectiveCoverageHref(item: ObjectiveItem, timeType: SecurityTimeType)') && objectivesPage.includes('function objectiveMaintenanceHref(item: ObjectiveItem, timeType: SecurityTimeType)') && objectivesPage.includes('function objectiveNotificationHref(item: ObjectiveItem)'),
      },
      evidencePage: {
        hasObjectiveTargetScope: evidencePage.includes('function objectiveTargetScope(objective: ObjectiveItem)'),
        hasObjectiveAgentScope: evidencePage.includes('if (objective.targetType === "agent") return splitAgentTargetId(targetId)'),
      },
      securityController: {
        hasObjectiveAgentScopeHydration: securityController.includes('const objectiveAgentScope = objective?.targetType === \'agent\' ? splitAgentTargetId(objective.targetId) : {}') && securityController.includes('objectiveAgentScope.workspacePath'),
      },
      alertingService: {
        hasObjectiveAgentAlertScope: alertingService.includes('const agentTarget = objective.targetType === \'agent\' ? splitAgentTargetId(objective.targetId) : {}') && alertingService.includes('const workspacePath = objective.targetType === \'workspace\' ? objective.targetId : agentTarget.workspacePath'),
      },
      objectiveService: {
        ...objectiveServiceScope,
        agentFilterPushdownCount: countOccurrences(objectiveService, 'agentId: agentTarget.agentId'),
        workspaceFilterPushdownCount: countOccurrences(objectiveService, 'workspacePath: workspaceTarget'),
        collectorFilterPushdownCount: countOccurrences(objectiveService, 'collectorId: collectorTarget'),
        sourceFilterPushdownCount: countOccurrences(objectiveService, 'sourceId: sourceTarget'),
      },
    },
  );
  assert(
    'dashboard Topology edge handoffs preserve route source and target-side scope',
    topologyPage.includes('routeSourceId?: string') &&
      topologyPage.includes('routeCollectorId?: string') &&
      topologyPage.includes('routeWorkspacePath?: string') &&
      topologyPage.includes('const edgeWorkspacePath = source?.workspacePath ?? target?.workspacePath ?? routeWorkspacePath') &&
      topologyPage.includes('const edgeCollectorId = source?.collectorId ?? target?.collectorId ?? routeCollectorId') &&
      topologyPage.includes('if (routeSourceId) eventQs.set("sourceId", routeSourceId)') &&
      topologyPage.includes('if (routeSourceId) bundleQs.set("sourceId", routeSourceId)') &&
      topologyPage.includes('routeSourceId={scopedSourceId}') &&
      evidencePage.includes('function topologyEdgeEvidenceHref(edge: AgentTopologyEdge, timeType: SecurityTimeType, scope: EvidenceBundleScope)') &&
      evidencePage.includes('sourceId: scope.sourceId') &&
      evidencePage.includes('topologyEdgeEvidenceHref(edge, timeType, bundle.scope)'),
    {
      topologyPage: {
        hasRouteScopeProps: topologyPage.includes('routeSourceId?: string') && topologyPage.includes('routeCollectorId?: string') && topologyPage.includes('routeWorkspacePath?: string'),
        hasTargetSideScopeFallback: topologyPage.includes('const edgeWorkspacePath = source?.workspacePath ?? target?.workspacePath ?? routeWorkspacePath') && topologyPage.includes('const edgeCollectorId = source?.collectorId ?? target?.collectorId ?? routeCollectorId'),
        hasSourceScopeHandoffs: topologyPage.includes('if (routeSourceId) eventQs.set("sourceId", routeSourceId)') && topologyPage.includes('if (routeSourceId) bundleQs.set("sourceId", routeSourceId)'),
      },
      evidencePage: {
        hasScopedTopologyEvidenceHref: evidencePage.includes('function topologyEdgeEvidenceHref(edge: AgentTopologyEdge, timeType: SecurityTimeType, scope: EvidenceBundleScope)') && evidencePage.includes('topologyEdgeEvidenceHref(edge, timeType, bundle.scope)'),
      },
    },
  );
  assert(
    'dashboard Audit handoffs preserve topology edge Evidence scope',
    auditPage.includes('addDetailParam(qs, item, "edgeId")') &&
      auditPage.includes('["auditId", "edgeId", "eventId"') &&
      evidencePage.includes('edgeId: typeof audit.details?.edgeId === "string" ? audit.details.edgeId : undefined'),
    {
      auditPage: {
        hasAuditEdgeDetail: auditPage.includes('addDetailParam(qs, item, "edgeId")'),
        hasAuditEdgeScope: auditPage.includes('["auditId", "edgeId", "eventId"'),
      },
      evidencePage: {
        hasAuditTrailEdgeScope: evidencePage.includes('edgeId: typeof audit.details?.edgeId === "string" ? audit.details.edgeId : undefined'),
      },
    },
  );
  assert(
    'dashboard Audit resource handoffs preserve structured selector scope',
    auditPage.includes('function addOperationalScopeParams(params: URLSearchParams, item: AuditListItem)') &&
      auditPage.includes('addOperationalScopeParams(qs, item)') &&
      auditPage.includes('const ingestionSourceId = detailText(item, "ingestionSourceId")') &&
      auditPage.includes('if (ingestionSourceId) qs.set("sourceId", ingestionSourceId)') &&
      auditPage.includes('addDetailParam(qs, item, "targetType")') &&
      auditPage.includes('addDetailParam(qs, item, "targetId")') &&
      auditPage.includes('addDetailParam(qs, item, "metric")') &&
      auditPage.includes('addDetailParam(qs, item, "minSeverity")') &&
      auditPage.includes('addDetailParam(qs, item, "owner")') &&
      auditPage.includes('addDetailParam(qs, item, "team")') &&
      securityController.includes('workspacePath: updated.workspacePath') &&
      securityController.includes('ingestionSourceId: updated.ingestionSourceId') &&
      securityController.includes('issueId: updated.sourceType === \'coverage\' ? updated.sourceId : updated.labels?.issueId') &&
      securityController.includes('owner: updated.owner') &&
      securityController.includes('team: updated.team'),
    {
      auditPage: {
        hasOperationalScopeHelper: auditPage.includes('function addOperationalScopeParams(params: URLSearchParams, item: AuditListItem)'),
        hasResourceScopeUse: auditPage.includes('addOperationalScopeParams(qs, item)'),
        hasRemediationIngestionSource: auditPage.includes('const ingestionSourceId = detailText(item, "ingestionSourceId")') && auditPage.includes('if (ingestionSourceId) qs.set("sourceId", ingestionSourceId)'),
        hasTargetSelectors: auditPage.includes('addDetailParam(qs, item, "targetType")') && auditPage.includes('addDetailParam(qs, item, "targetId")') && auditPage.includes('addDetailParam(qs, item, "metric")'),
        hasNotificationSelectors: auditPage.includes('addDetailParam(qs, item, "minSeverity")') && auditPage.includes('addDetailParam(qs, item, "owner")') && auditPage.includes('addDetailParam(qs, item, "team")'),
      },
      securityController: {
        hasWorkspaceAuditDetail: securityController.includes('workspacePath: updated.workspacePath'),
        hasRemediationSourceAuditDetail: securityController.includes('ingestionSourceId: updated.ingestionSourceId'),
        hasRemediationIssueAuditDetail: securityController.includes('issueId: updated.sourceType === \'coverage\' ? updated.sourceId : updated.labels?.issueId'),
        hasNotificationOwnerTeamAuditDetail: securityController.includes('owner: updated.owner') && securityController.includes('team: updated.team'),
      },
    },
  );
  assert(
    'dashboard Maintenance handoffs preserve composite agent target scope',
    maintenancePage.includes('function splitAgentTargetId(targetId: string)') &&
      maintenancePage.includes('const scope = splitAgentTargetId(item.targetId)') &&
      maintenancePage.includes('params.set("workspacePath", scope.workspacePath)') &&
      maintenancePage.includes('new URLSearchParams({ agentId: scope.agentId })') &&
      evidencePage.includes('const agentScope = window.targetType === "agent" ? splitAgentTargetId(window.targetId) : undefined') &&
      evidencePage.includes('agentId: agentScope?.agentId') &&
      evidencePage.includes('workspacePath: agentScope.workspacePath'),
    {
      hasSplitter: maintenancePage.includes('function splitAgentTargetId(targetId: string)'),
      hasSplitUse: maintenancePage.includes('const scope = splitAgentTargetId(item.targetId)'),
      hasWorkspaceScope: maintenancePage.includes('params.set("workspacePath", scope.workspacePath)'),
      hasAgentTargetLink: maintenancePage.includes('new URLSearchParams({ agentId: scope.agentId })'),
      evidencePage: {
        hasMaintenanceAgentSplit: evidencePage.includes('const agentScope = window.targetType === "agent" ? splitAgentTargetId(window.targetId) : undefined'),
        hasMaintenanceAgentScope: evidencePage.includes('agentId: agentScope?.agentId'),
        hasMaintenanceWorkspaceScope: evidencePage.includes('workspacePath: agentScope.workspacePath'),
      },
    },
  );
}

async function verifyManagementRoutes() {
  for (const route of managementRoutes) {
    const page = await fetchText(route);
    assert(
      `dashboard route serves SPA index: ${route}`,
      page.res.ok && isDashboardHtml(page.text) && !page.text.includes('Cannot GET'),
      { url: page.url, status: page.res.status, preview: page.text.slice(0, 160) },
    );
  }
}

async function verifyApiIsNotCapturedBySpa() {
  await verifyApiBase(apiBase, 'security-center API');

  const web = new URL(webBase);
  const prefix = web.pathname.replace(/\/$/, '');
  if (prefix) {
    await verifyApiBase(`${web.origin}${prefix}/security-center`, 'base-path security-center API');
  }
}

async function verifyApiBase(base, label) {
  const healthRes = await fetch(`${base}/healthz`, { headers: { accept: 'application/json' } });
  const healthType = healthRes.headers.get('content-type') ?? '';
  const healthBody = await healthRes.json();
  assert(
    `${label} healthz returns platform health JSON`,
    healthRes.ok &&
      healthType.includes('application/json') &&
      healthBody.code === 200 &&
      healthBody.data?.schemaVersion === 'anysentry.health.v1' &&
      healthBody.data?.status === 'ok' &&
      (healthBody.data?.storage?.mode === 'memory' || healthBody.data?.storage?.mode === 'clickhouse') &&
      typeof healthBody.data?.uptimeSeconds === 'number',
    { status: healthRes.status, contentType: healthType, healthBody },
  );

  const statsRes = await fetch(`${base}/stats`, { headers: { accept: 'application/json' } });
  const statsType = statsRes.headers.get('content-type') ?? '';
  const statsBody = await statsRes.json();
  assert(
    `${label} GET returns JSON, not dashboard HTML`,
    statsRes.ok && statsType.includes('application/json') && statsBody.code === 200 && typeof statsBody.data === 'object',
    { status: statsRes.status, contentType: statsType, statsBody },
  );

  const listRes = await fetch(`${base}/events/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ timeType: 'last_30d', limit: 5 }),
  });
  const listType = listRes.headers.get('content-type') ?? '';
  const listBody = await listRes.json();
  assert(
    `${label} POST returns wrapped JSON list`,
    listRes.ok && listType.includes('application/json') && Array.isArray(listBody.data?.items),
    { status: listRes.status, contentType: listType, listBody },
  );

  await verifyAgentObservabilityStream(base, label);
}

async function verifyAgentObservabilityStream(base, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let response;
  let raw = '';
  let frame;

  try {
    response = await fetch(`${base}/sessions/agentObservability/stream?timeType=last_30d`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') ?? '';
    assert(
      `${label} live observability stream returns SSE`,
      response.ok && contentType.toLowerCase().includes('text/event-stream') && Boolean(response.body),
      { status: response.status, contentType },
    );
    if (!response.ok || !response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (!frame) {
        const { value, done } = await reader.read();
        if (value) raw += decoder.decode(value, { stream: !done });
        const blocks = raw.split(/\r?\n\r?\n/);
        raw = blocks.pop() ?? '';
        for (const block of blocks) {
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('');
          if (!data) continue;
          frame = JSON.parse(data);
          break;
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      fail(`${label} live observability stream emits a frame before timeout`);
      return;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }

  assert(
    `${label} live observability stream emits unwrapped AgentObservability data`,
    Boolean(
      frame &&
        frame.health &&
        typeof frame.health.heartbeatOk === 'boolean' &&
        frame.behavioral &&
        frame.system &&
        typeof frame.updateTime === 'string' &&
        frame.code === undefined &&
        frame.data === undefined,
    ),
    { frame, rawPreview: raw.slice(0, 300) },
  );
}

async function main() {
  console.log(`AnySentry dashboard runtime verification against ${webBase} with API ${apiBase}`);
  await verifyIndexAndAssets();
  await verifyDashboardSourceContracts();
  await verifyManagementRoutes();
  await verifyApiIsNotCapturedBySpa();

  if (process.exitCode) {
    console.error('Dashboard runtime verification failed');
    process.exit(process.exitCode);
  }
  console.log('Dashboard runtime verification passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
