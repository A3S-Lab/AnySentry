#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const apiBase = process.env.ANYSENTRY_API_BASE?.replace(/\/+$/u, '');

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
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

function hasAll(text, values) {
  return values.every((value) => text.includes(value));
}

async function request(pathname, init) {
  if (!apiBase) throw new Error('ANYSENTRY_API_BASE is not set');
  const adminToken = process.env.ANYSENTRY_ADMIN_TOKEN?.trim() || process.env.ANYSENTRY_MANAGEMENT_TOKEN?.trim();
  const response = await fetch(`${apiBase}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(adminToken ? { 'X-AnySentry-Admin-Token': adminToken } : {}), ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body = text ? JSON.parse(text) : undefined;
  if (body && typeof body === 'object' && 'code' in body && 'data' in body) body = body.data;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  return body;
}

async function eventually(label, fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}

function verifyStaticContract() {
  const controller = readText('apps/api/src/security-monitoring/security-monitoring.controller.ts');
  const apiTypes = readText('apps/api/src/security-monitoring/types.ts');
  const webClient = readText('apps/web/src/lib/api/security-center.ts');
  const readme = readText('README.md');
  const deployReadme = readText('deploy/README.md');
  const packageJson = JSON.parse(readText('package.json'));

  const actions = ['list', 'search', 'describe', 'execute'];
  assert('controller exposes GET /security-center/capabilities', /@Get\('capabilities'\)/u.test(controller), controller);
  assert('controller exposes POST /security-center/capabilities', /@Post\('capabilities'\)/u.test(controller), controller);
  assert('controller supports the source-compatible progressive action set', hasAll(controller, actions.map((action) => `'${action}'`)), controller);
  assert('controller does not expose ACP-only poll/subscribe/approve actions as the primary protocol', !/['"](poll|subscribe|approve)['"]/u.test(controller), controller);
  assert('controller publishes source-compatible protocol metadata', controller.includes("protocol: 'shuanos-progressive-api/source-compatible'"), controller);
  assert(
    'controller defines module/operation progressive entries',
    hasAll(controller, ['SECURITY_PROGRESSIVE_MODULE', 'assessRuntimeAction', 'recordSecurityEvents', 'buildEvidenceBundle', 'planNextActions']),
    controller,
  );
  assert(
    'progressive operation schemas use canonical result versions',
    controller.includes("schemaVersion: 'anysentry.evidence_bundle.v1'") &&
      controller.includes("schemaVersion: 'anysentry.progressive.runtime_guard.result.v1'") &&
      controller.includes("schemaVersion: 'anysentry.progressive.next_action_plan.v1'") &&
      controller.includes("schemaVersion: 'anysentry.progressive.dry_run.v1'") &&
      !controller.includes("schemaVersion: 'anysentry.evidence.bundle.v1'") &&
      !controller.includes("schemaVersion: 'anysentry.universal_ingest.result.v1'"),
    controller,
  );
  assert(
    'controller dry-run validates execute requests against the described input schema',
    controller.includes('function validateSecurityCapabilitySchema(schema: unknown, value: unknown') &&
      controller.includes('const schemaIssues = validateSecurityCapabilitySchema(obj(operation.inputSchema)?.body, input)') &&
      controller.includes('schemaValid') &&
      controller.includes('normalizedRequest'),
    controller,
  );
  assert('controller uses loop-autonomy vocabulary', hasAll(controller, ["'suggest'", "'guarded'", "'auto'", "'require_approval'"]), controller);
  assert(
    'controller normalizes coding-agent event kind aliases',
    hasAll(controller, ['networkegress', 'fileread', 'filewrite', 'securityfinding']),
    controller,
  );
  assert('legacy ai-native endpoints are not exposed', !/ai-native|AiNative|aiNative|AI_NATIVE/u.test(controller), controller);

  assert('API types define SecurityCapabilityAction with all actions', hasAll(apiTypes, ['SecurityCapabilityAction', ...actions.map((action) => `'${action}'`)]), apiTypes);
  assert('API types define progressive ApiModule/ApiOperation shapes', hasAll(apiTypes, ['SecurityApiModule', 'SecurityApiOperation', 'module?: string', 'operation?: string']), apiTypes);
  assert(
    'web client uses the progressive capabilities endpoint',
    webClient.includes('securityCapabilities') &&
      webClient.includes('nextActionPlan') &&
      webClient.includes('evidenceBundleCapability') &&
      webClient.includes('/security-center/capabilities'),
    webClient,
  );
  assert('web client has no legacy AiNative type surface', !/AiNative|aiNative|AI_NATIVE|ai-native/u.test(webClient), webClient);
  assert(
    'README documents the source-compatible progressive capability API',
    readme.includes('Source-compatible progressive capability API') &&
      readme.includes('module + operation + params') &&
      readme.includes('planNextActions') &&
      readme.includes('pnpm verify:progressive-api'),
    readme,
  );
  assert('deploy README documents one-command integrated install', deployReadme.includes('deploy/install.sh docker') && deployReadme.includes('ANYSENTRY_INSTALL_MODE=kubernetes'), deployReadme);
  assert('package scripts expose progressive API verifier aliases', packageJson.scripts?.['verify:progressive-api'] === 'pnpm verify:ai-native-api' && packageJson.scripts?.['verify:progressive-api:local'] === 'pnpm verify:ai-native-api:local', packageJson.scripts);
}

async function verifyRuntimeContract() {
  if (!apiBase) {
    console.log('SKIP runtime progressive API checks (ANYSENTRY_API_BASE not set)');
    return;
  }

  const list = await request('/capabilities?action=list');
  assert('runtime list returns raw progressive modules', Array.isArray(list) && list.some((module) => module.name === 'security-center'), list);

  const search = await request('/capabilities?action=search&query=runtime%20guard');
  assert('runtime search returns operation matches', Array.isArray(search) && search.some((operation) => operation.name === 'assessRuntimeAction'), search);

  const describeModule = await request('/capabilities?action=describe&module=security-center');
  assert('runtime describe returns the security-center module', describeModule?.name === 'security-center' && Array.isArray(describeModule?.operations), describeModule);

  const describe = await request('/capabilities?action=describe&module=security-center&operation=assessRuntimeAction');
  assert('runtime describe narrows to one operation schema', describe?.name === 'assessRuntimeAction' && describe?.inputSchema && describe?.outputSchema, describe);
  assert(
    'runtime guard describe advertises the actual runtime guard result schema',
    describe?.outputSchema?.data?.schemaVersion === 'anysentry.progressive.runtime_guard.result.v1',
    describe,
  );
  const guardParamsSchema = describe?.inputSchema?.body?.properties?.params;
  assert(
    'runtime guard describe exposes a typed executable params schema',
    guardParamsSchema?.type === 'object' &&
      guardParamsSchema?.properties?.autonomy?.enum?.includes('guarded') &&
      guardParamsSchema?.properties?.stage?.enum?.includes('tool') &&
      Array.isArray(guardParamsSchema?.properties?.command?.oneOf) &&
      describe?.outputSchema?.data?.properties?.policyAction?.enum?.includes('require_approval') &&
      describe?.examples?.some((example) => example?.request?.operation === 'assessRuntimeAction' && example?.request?.module === 'security-center'),
    describe,
  );

  const describeRecord = await request('/capabilities?action=describe&module=security-center&operation=recordSecurityEvents');
  assert(
    'recordSecurityEvents describe advertises the actual ingest result shape',
    describeRecord?.name === 'recordSecurityEvents' &&
      describeRecord?.outputSchema?.data?.type === 'object' &&
      describeRecord?.outputSchema?.data?.properties?.acceptedEvents?.type === 'number' &&
      !describeRecord?.outputSchema?.data?.schemaVersion,
    describeRecord,
  );
  const recordParamsSchema = describeRecord?.inputSchema?.body?.properties?.params;
  assert(
    'recordSecurityEvents describe exposes structured ingest params schema',
    recordParamsSchema?.type === 'object' &&
      Array.isArray(recordParamsSchema?.anyOf) &&
      recordParamsSchema?.properties?.sourceType?.enum?.includes('custom') &&
      recordParamsSchema?.properties?.events?.type === 'array' &&
      recordParamsSchema?.properties?.events?.items?.properties?.eventCategory?.enum?.includes('tool') &&
      describeRecord?.examples?.some((example) => example?.request?.operation === 'recordSecurityEvents' && Array.isArray(example?.request?.params?.events)),
    describeRecord,
  );

  const describeBundle = await request('/capabilities?action=describe&module=security-center&operation=buildEvidenceBundle');
  assert(
    'buildEvidenceBundle describe advertises the actual evidence bundle schema',
    describeBundle?.name === 'buildEvidenceBundle' && describeBundle?.outputSchema?.data?.schemaVersion === 'anysentry.evidence_bundle.v1',
    describeBundle,
  );
  const bundleParamsSchema = describeBundle?.inputSchema?.body?.properties?.params;
  assert(
    'buildEvidenceBundle describe exposes primary evidence selector params schema',
    bundleParamsSchema?.type === 'object' &&
      bundleParamsSchema?.additionalProperties === false &&
      bundleParamsSchema?.properties?.eventId?.type === 'string' &&
      bundleParamsSchema?.properties?.taskId?.type === 'string' &&
      bundleParamsSchema?.properties?.limit?.maximum === 500 &&
      describeBundle?.outputSchema?.data?.properties?.summary?.properties?.eventCount?.type === 'number' &&
      describeBundle?.examples?.some((example) => example?.request?.operation === 'buildEvidenceBundle' && example?.request?.params?.workspacePath),
    describeBundle,
  );

  const describePlan = await request('/capabilities?action=describe&module=security-center&operation=planNextActions');
  assert(
    'planNextActions describe advertises the actual next-action plan schema',
    describePlan?.name === 'planNextActions' && describePlan?.outputSchema?.data?.schemaVersion === 'anysentry.progressive.next_action_plan.v1',
    describePlan,
  );
  const planParamsSchema = describePlan?.inputSchema?.body?.properties?.params;
  assert(
    'planNextActions describe exposes ranked-action filter params schema',
    planParamsSchema?.type === 'object' &&
      planParamsSchema?.additionalProperties === false &&
      planParamsSchema?.properties?.status?.enum?.includes('in_progress') &&
      planParamsSchema?.properties?.sourceType?.enum?.includes('coverage') &&
      planParamsSchema?.properties?.maxActions?.maximum === 20 &&
      describePlan?.outputSchema?.data?.properties?.actions?.items?.properties?.evidence?.properties?.bundleHint?.properties?.taskId?.type === 'string' &&
      describePlan?.examples?.some((example) => example?.request?.operation === 'planNextActions' && example?.request?.params?.maxActions),
    describePlan,
  );

  const shaped = await request('/capabilities?action=list&shaped=true');
  assert('runtime shaped=true returns tool-friendly envelope', shaped?.protocol === 'shuanos-progressive-api/source-compatible' && shaped?.success === true && shaped?.modules?.length, shaped);

  const runId = `verify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const workspacePath = `repo://${runId}`;
  const agentId = `${runId}-agent`;
  const sessionId = `${runId}-session`;

  const dryRun = await request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      module: 'security-center',
      operation: 'assessRuntimeAction',
      dryRun: true,
      params: {
        autonomy: 'guarded',
        stage: 'tool',
        workspacePath,
        agentId,
        sessionId,
        toolName: 'bash',
        command: ['bash', '-lc', 'id'],
      },
    }),
  });
  assert(
    'runtime execute dryRun returns a schema-aware valid preflight decision',
    dryRun?.schemaVersion === 'anysentry.progressive.dry_run.v1' &&
      dryRun?.valid === true &&
      dryRun?.schemaValid === true &&
      Array.isArray(dryRun?.schemaIssues) &&
      dryRun.schemaIssues.length === 0 &&
      dryRun?.module === 'security-center' &&
      dryRun?.operation === 'assessRuntimeAction' &&
      dryRun?.normalizedRequest?.operation === 'assessRuntimeAction',
    dryRun,
  );

  const invalidDryRun = await request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      module: 'security-center',
      operation: 'planNextActions',
      dryRun: true,
      params: {
        status: 'not-a-status',
        maxActions: 99,
        unexpected: true,
      },
    }),
  });
  assert(
    'runtime execute dryRun reports input schema issues without executing side effects',
    invalidDryRun?.schemaVersion === 'anysentry.progressive.dry_run.v1' &&
      invalidDryRun?.valid === false &&
      invalidDryRun?.schemaValid === false &&
      invalidDryRun?.decision === 'reject' &&
      invalidDryRun?.operation === 'planNextActions' &&
      invalidDryRun?.schemaIssues?.some((issue) => issue.path === '$.params.status') &&
      invalidDryRun?.schemaIssues?.some((issue) => issue.path === '$.params.maxActions') &&
      invalidDryRun?.schemaIssues?.some((issue) => issue.path === '$.params.unexpected'),
    invalidDryRun,
  );

  const guarded = await request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      module: 'security-center',
      operation: 'assessRuntimeAction',
      params: {
        autonomy: 'guarded',
        stage: 'tool',
        workspacePath,
        agentId,
        sessionId,
        runId,
        toolName: 'bash',
        command: ['bash', '-lc', 'curl http://169.254.169.254/latest/meta-data'],
      },
    }),
  });
  assert(
    'runtime execute assesses an obvious high-risk guard event as non-allow',
    guarded?.schemaVersion === 'anysentry.progressive.runtime_guard.result.v1' &&
      guarded?.schemaVersion === describe.outputSchema.data.schemaVersion &&
      guarded?.module === 'security-center' &&
      guarded?.operation === 'assessRuntimeAction' &&
      guarded?.eventId &&
      ['warn', 'require_approval', 'block'].includes(guarded?.policyAction) &&
      guarded?.recommendedAction !== 'continue' &&
      guarded?.verdict !== 'allow',
    guarded,
  );
  const guardedEvidence = await eventually('runtime guard fallback finding evidence', async () => {
    const list = await request('/events/list', {
      method: 'POST',
      body: JSON.stringify({ timeType: 'last_30d', runId, agentId, limit: 20 }),
    });
    return list.items?.find((item) => item.eventId === guarded.eventId);
  });
  assert(
    'runtime guard decision points at actionable evidence',
    guardedEvidence?.verdict && guardedEvidence.verdict !== 'allow',
    guardedEvidence,
  );

  const fallbackOnly = await request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      module: 'security-center',
      operation: 'assessRuntimeAction',
      params: {
        autonomy: 'guarded',
        stage: 'tool',
        workspacePath,
        agentId,
        sessionId,
        runId,
        toolName: 'cat',
        command: ['cat', '/workspace/.kube/config'],
      },
    }),
  });
  assert(
    'runtime guard fallback blocks credential-path tool actions',
    fallbackOnly?.schemaVersion === 'anysentry.progressive.runtime_guard.result.v1' &&
      fallbackOnly?.eventId &&
      ['warn', 'require_approval', 'block'].includes(fallbackOnly?.policyAction) &&
      fallbackOnly?.recommendedAction !== 'continue' &&
      fallbackOnly?.verdict !== 'allow',
    fallbackOnly,
  );
  const fallbackFinding = await eventually('runtime guard fallback finding evidence', async () => {
    const list = await request('/events/list', {
      method: 'POST',
      body: JSON.stringify({ timeType: 'last_30d', runId, agentId, limit: 30 }),
    });
    return list.items?.find((item) => item.eventId === fallbackOnly.eventId && item.eventKind === 'SecurityAction');
  });
  assert(
    'runtime guard fallback persists actionable SecurityFinding evidence',
    fallbackFinding?.verdict &&
      fallbackFinding.verdict !== 'allow' &&
      fallbackFinding?.attributes?.['progressive.guard.fallback'] === true &&
      fallbackFinding?.attributes?.['progressive.guard.actionEventId'],
    fallbackFinding,
  );

  const aliasRunId = `${runId}-alias`;
  const aliasWorkspacePath = `${workspacePath}/aliases`;
  const aliasAgentId = `${agentId}-alias`;
  const aliasSessionId = `${sessionId}-alias`;
  const aliasRecorded = await request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      module: 'security-center',
      operation: 'recordSecurityEvents',
      params: {
        sourceName: 'progressive-alias-verifier',
        sourceType: 'custom',
        workspacePath: aliasWorkspacePath,
        agentId: aliasAgentId,
        sessionId: aliasSessionId,
        events: [
          {
            kind: 'NetworkEgress',
            workspacePath: aliasWorkspacePath,
            agentId: aliasAgentId,
            sessionId: aliasSessionId,
            runId: aliasRunId,
            peer: '169.254.169.254',
            port: 80,
            subject: 'metadata service egress alias should canonicalize to Egress',
          },
          {
            kind: 'FileRead',
            workspacePath: aliasWorkspacePath,
            agentId: aliasAgentId,
            sessionId: aliasSessionId,
            runId: aliasRunId,
            path: '/home/dev/.aws/credentials',
            subject: 'credential file read alias should canonicalize to FileAccess',
          },
          {
            kind: 'FileWrite',
            workspacePath: aliasWorkspacePath,
            agentId: aliasAgentId,
            sessionId: aliasSessionId,
            runId: aliasRunId,
            path: '/workspace/out/report.json',
            subject: 'file write alias should canonicalize to FileAccess',
          },
          {
            kind: 'SecurityFinding',
            workspacePath: aliasWorkspacePath,
            agentId: aliasAgentId,
            sessionId: aliasSessionId,
            runId: aliasRunId,
            status: 'failed',
            subject: 'runner failure finding should canonicalize to SecurityAction',
          },
        ],
      },
    }),
  });
  const aliasEventIds = aliasRecorded?.items?.map((item) => item.eventId).filter(Boolean) ?? [];
  assert(
    'runtime recordSecurityEvents accepts coding-agent alias event kinds',
    aliasRecorded?.accepted === true && aliasRecorded?.acceptedEvents === 4 && aliasEventIds.length === 4,
    aliasRecorded,
  );

  const aliasEvents = await eventually('alias events to be queryable with canonical kinds', async () => {
    const list = await request('/events/list', {
      method: 'POST',
      body: JSON.stringify({ timeType: 'last_30d', runId: aliasRunId, agentId: aliasAgentId, limit: 20 }),
    });
    const matches = list.items?.filter((item) => aliasEventIds.includes(item.eventId)) ?? [];
    return matches.length === aliasEventIds.length ? matches : undefined;
  });
  const aliasKinds = aliasEvents.map((event) => event.eventKind);
  assert(
    'runtime canonicalizes coding-agent aliases into supported event kinds',
    aliasKinds.includes('Egress') && aliasKinds.filter((kind) => kind === 'FileAccess').length === 2 && aliasKinds.includes('SecurityAction'),
    aliasEvents,
  );
  assert(
    'runtime negative-path aliases keep non-allow verdict coverage',
    aliasEvents.some((event) => ['Egress', 'FileAccess'].includes(event.eventKind) && event.verdict && event.verdict !== 'allow') &&
      aliasEvents.some((event) => event.eventKind === 'SecurityAction' && event.verdict && event.verdict !== 'allow'),
    aliasEvents,
  );

  const plan = await request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      module: 'security-center',
      operation: 'planNextActions',
      params: {
        timeType: 'last_1d',
        workspacePath,
        agentId,
        maxActions: 3,
      },
    }),
  });
  assert(
    'runtime execute returns an evidence-linked AI next-action plan',
    plan?.schemaVersion === 'anysentry.progressive.next_action_plan.v1' &&
      plan?.schemaVersion === describePlan.outputSchema.data.schemaVersion &&
      plan?.module === 'security-center' &&
      plan?.operation === 'planNextActions' &&
      Array.isArray(plan?.actions) &&
      plan.actions.length >= 1 &&
      plan.actions[0]?.workspacePath === workspacePath &&
      plan.actions[0]?.agentId === agentId &&
      plan.actions[0]?.evidence?.bundleHint,
    plan,
  );
  const action = plan.actions[0];

  const bundle = await request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      module: 'security-center',
      operation: 'buildEvidenceBundle',
      params: {
        timeType: 'last_1d',
        limit: 40,
        ...action.evidence.bundleHint,
        taskId: action.taskId,
        eventId: action.eventId ?? guarded.eventId,
        agentId,
        workspacePath,
      },
    }),
  });
  assert(
    'runtime AI Operator evidence hint builds a matching governance bundle',
    bundle?.schemaVersion === 'anysentry.evidence_bundle.v1' &&
      bundle?.schemaVersion === describeBundle.outputSchema.data.schemaVersion &&
      bundle?.summary?.eventCount >= 1 &&
      bundle?.events?.some((event) => event.eventId === guarded.eventId) &&
      bundle?.remediations?.some((task) => task.taskId === action.taskId),
    bundle,
  );

  const inProgress = await request(`/remediations/${encodeURIComponent(action.taskId)}`, {
    method: 'PUT',
    body: JSON.stringify({
      status: 'in_progress',
      note: `progressive operator loop ${runId}`,
    }),
  });
  assert('runtime Operator loop can advance the planned action to in_progress', inProgress?.taskId === action.taskId && inProgress?.status === 'in_progress', inProgress);

  const refreshedPlan = await request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      module: 'security-center',
      operation: 'planNextActions',
      params: {
        timeType: 'last_1d',
        workspacePath,
        agentId,
        maxActions: 5,
      },
    }),
  });
  assert(
    'runtime Operator loop refreshes next-action status after Remediation update',
    refreshedPlan?.schemaVersion === 'anysentry.progressive.next_action_plan.v1' &&
      refreshedPlan?.actions?.some((item) => item.taskId === action.taskId && item.status === 'in_progress'),
    refreshedPlan,
  );

  const completed = await request(`/remediations/${encodeURIComponent(action.taskId)}`, {
    method: 'PUT',
    body: JSON.stringify({
      status: 'done',
      note: `progressive operator loop completed ${runId}`,
    }),
  });
  assert('runtime Operator loop can complete the planned action', completed?.taskId === action.taskId && completed?.status === 'done', completed);

  const activePlan = await request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      module: 'security-center',
      operation: 'planNextActions',
      params: {
        timeType: 'last_1d',
        workspacePath,
        agentId,
        maxActions: 5,
      },
    }),
  });
  assert(
    'runtime Operator loop removes completed work from default next-action candidates',
    activePlan?.schemaVersion === 'anysentry.progressive.next_action_plan.v1' && !activePlan?.actions?.some((item) => item.taskId === action.taskId),
    activePlan,
  );

  const legacy = await request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      capabilityId: 'security.runtimeGuard',
      operation: 'assessAction',
      dryRun: true,
      params: { autonomy: 'suggest', stage: 'tool', toolName: 'bash', command: ['bash', '-lc', 'id'] },
    }),
  });
  assert('runtime keeps legacy capabilityId as a compatibility alias', legacy?.module === 'security-center' && legacy?.operation === 'assessRuntimeAction', legacy);

  let rejected = false;
  try {
    await request('/capabilities?action=approve&runId=verify-run');
  } catch {
    rejected = true;
  }
  assert('runtime rejects ACP-only approve action', rejected, { rejected });
}

async function main() {
  console.log('AnySentry progressive API verification');
  verifyStaticContract();
  await verifyRuntimeContract();

  if (process.exitCode) {
    console.error('Progressive API verification failed');
    process.exit(process.exitCode);
  }
  console.log('Progressive API verification passed');
}

main().catch((error) => {
  fail('runtime verification threw', error instanceof Error ? error.message : String(error));
  process.exit(process.exitCode || 1);
});
