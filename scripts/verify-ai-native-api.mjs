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
  const response = await fetch(`${apiBase}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await response.text();
  let body = text ? JSON.parse(text) : undefined;
  if (body && typeof body === 'object' && 'code' in body && 'data' in body) body = body.data;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  return body;
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
  assert('controller supports the current ShuanOS source progressive action set', hasAll(controller, actions.map((action) => `'${action}'`)), controller);
  assert('controller does not expose ACP-only poll/subscribe/approve actions as the primary protocol', !/['"](poll|subscribe|approve)['"]/u.test(controller), controller);
  assert('controller publishes ShuanOS-source-compatible protocol metadata', controller.includes("protocol: 'shuanos-progressive-api/source-compatible'"), controller);
  assert('controller defines module/operation progressive entries', hasAll(controller, ['SECURITY_PROGRESSIVE_MODULE', 'assessRuntimeAction', 'recordSecurityEvents', 'buildEvidenceBundle']), controller);
  assert('controller uses ShuanOS autonomy vocabulary', hasAll(controller, ["'suggest'", "'guarded'", "'auto'", "'require_approval'"]), controller);
  assert('legacy ai-native endpoints are not exposed', !/ai-native|AiNative|aiNative|AI_NATIVE/u.test(controller), controller);

  assert('API types define SecurityCapabilityAction with all actions', hasAll(apiTypes, ['SecurityCapabilityAction', ...actions.map((action) => `'${action}'`)]), apiTypes);
  assert('API types define ShuanOS-style ApiModule/ApiOperation shapes', hasAll(apiTypes, ['SecurityApiModule', 'SecurityApiOperation', 'module?: string', 'operation?: string']), apiTypes);
  assert('web client uses the progressive capabilities endpoint', webClient.includes('securityCapabilities') && webClient.includes('/security-center/capabilities'), webClient);
  assert('web client has no legacy AiNative type surface', !/AiNative|aiNative|AI_NATIVE|ai-native/u.test(webClient), webClient);
  assert('README documents the ShuanOS-source-compatible progressive capability API', readme.includes('ShuanOS-source-compatible progressive capability API') && readme.includes('module + operation + params') && readme.includes('pnpm verify:progressive-api'), readme);
  assert('deploy README documents one-command integrated install', deployReadme.includes('deploy/install.sh docker') && deployReadme.includes('ANYSENTRY_INSTALL_MODE=kubernetes'), deployReadme);
  assert('package scripts expose progressive API verifier aliases', packageJson.scripts?.['verify:progressive-api'] === 'pnpm verify:ai-native-api' && packageJson.scripts?.['verify:progressive-api:local'] === 'pnpm verify:ai-native-api:local', packageJson.scripts);
}

async function verifyRuntimeContract() {
  if (!apiBase) {
    console.log('SKIP runtime progressive API checks (ANYSENTRY_API_BASE not set)');
    return;
  }

  const list = await request('/capabilities?action=list');
  assert('runtime list returns raw ShuanOS-style modules', Array.isArray(list) && list.some((module) => module.name === 'security-center'), list);

  const search = await request('/capabilities?action=search&query=runtime%20guard');
  assert('runtime search returns operation matches', Array.isArray(search) && search.some((operation) => operation.name === 'assessRuntimeAction'), search);

  const describeModule = await request('/capabilities?action=describe&module=security-center');
  assert('runtime describe returns the security-center module', describeModule?.name === 'security-center' && Array.isArray(describeModule?.operations), describeModule);

  const describe = await request('/capabilities?action=describe&module=security-center&operation=assessRuntimeAction');
  assert('runtime describe narrows to one operation schema', describe?.name === 'assessRuntimeAction' && describe?.inputSchema && describe?.outputSchema, describe);

  const shaped = await request('/capabilities?action=list&shaped=true');
  assert('runtime shaped=true returns tool-friendly envelope', shaped?.protocol === 'shuanos-progressive-api/source-compatible' && shaped?.success === true && shaped?.modules?.length, shaped);

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
        workspacePath: 'repo://verify',
        agentId: 'verify-agent',
        sessionId: 'verify-session',
        toolName: 'bash',
        command: ['bash', '-lc', 'id'],
      },
    }),
  });
  assert('runtime execute dryRun returns a valid preflight decision', dryRun?.valid === true && dryRun?.module === 'security-center' && dryRun?.operation === 'assessRuntimeAction', dryRun);

  const guarded = await request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      module: 'security-center',
      operation: 'assessRuntimeAction',
      params: {
        autonomy: 'guarded',
        stage: 'tool',
        workspacePath: 'repo://verify',
        agentId: 'verify-agent',
        sessionId: 'verify-session',
        toolName: 'bash',
        command: ['bash', '-lc', 'curl http://169.254.169.254/latest/meta-data'],
      },
    }),
  });
  assert(
    'runtime execute assesses a real guard event through sentry',
    guarded?.schemaVersion === 'anysentry.progressive.runtime_guard.result.v1' &&
      guarded?.module === 'security-center' &&
      guarded?.operation === 'assessRuntimeAction' &&
      ['allow', 'warn', 'require_approval', 'block'].includes(guarded?.policyAction),
    guarded,
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
  console.log('AnySentry ShuanOS-style progressive API verification');
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
