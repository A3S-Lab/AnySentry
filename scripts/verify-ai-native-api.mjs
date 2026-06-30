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

  const actions = ['list', 'search', 'describe', 'execute', 'poll', 'subscribe', 'approve'];
  assert('controller exposes GET /security-center/capabilities', /@Get\('capabilities'\)/u.test(controller), controller);
  assert('controller exposes POST /security-center/capabilities', /@Post\('capabilities'\)/u.test(controller), controller);
  assert('controller supports the ShuanOS progressive action set', hasAll(controller, actions.map((action) => `'${action}'`)), controller);
  assert('controller publishes ACP-compatible protocol metadata', controller.includes("protocol: 'acp/0.1-compatible'"), controller);
  assert('controller defines runtime guard, event ingest, and evidence capabilities', hasAll(controller, ['security.runtimeGuard', 'security.eventIngest', 'security.evidenceBundle']), controller);
  assert('controller uses ShuanOS autonomy vocabulary', hasAll(controller, ["'suggest'", "'guarded'", "'auto'", "'require_approval'"]), controller);
  assert('legacy ai-native endpoints are not exposed', !/ai-native|AiNative|aiNative|AI_NATIVE/u.test(controller), controller);

  assert('API types define SecurityCapabilityAction with all actions', hasAll(apiTypes, ['SecurityCapabilityAction', ...actions.map((action) => `'${action}'`)]), apiTypes);
  assert('API types define ACP risk tiers L0-L5', hasAll(apiTypes, ['SecurityCapabilityTier', "'L0'", "'L1'", "'L2'", "'L3'", "'L4'", "'L5'"]), apiTypes);
  assert('web client uses the progressive capabilities endpoint', webClient.includes('securityCapabilities') && webClient.includes('/security-center/capabilities'), webClient);
  assert('web client has no legacy AiNative type surface', !/AiNative|aiNative|AI_NATIVE|ai-native/u.test(webClient), webClient);
  assert('README documents the ShuanOS-style progressive capability API', readme.includes('ShuanOS-style progressive capability API') && readme.includes('/security-center/capabilities') && readme.includes('pnpm verify:progressive-api'), readme);
  assert('deploy README documents one-command integrated install', deployReadme.includes('deploy/install.sh docker') && deployReadme.includes('ANYSENTRY_INSTALL_MODE=kubernetes'), deployReadme);
  assert('package scripts expose progressive API verifier aliases', packageJson.scripts?.['verify:progressive-api'] === 'pnpm verify:ai-native-api' && packageJson.scripts?.['verify:progressive-api:local'] === 'pnpm verify:ai-native-api:local', packageJson.scripts);
}

async function verifyRuntimeContract() {
  if (!apiBase) {
    console.log('SKIP runtime ACP checks (ANYSENTRY_API_BASE not set)');
    return;
  }

  const list = await request('/capabilities?action=list');
  assert('runtime list returns ACP-compatible response', list?.protocol === 'acp/0.1-compatible' && list?.action === 'list', list);
  assert('runtime list includes security.runtimeGuard', list?.capabilities?.some((capability) => capability.capabilityId === 'security.runtimeGuard'), list);

  const describe = await request('/capabilities?action=describe&capabilityId=security.runtimeGuard');
  assert('runtime describe returns runtime guard manifest', describe?.capability?.capabilityId === 'security.runtimeGuard', describe);
  assert('runtime describe exposes assessAction schema refs', describe?.operations?.some((operation) => operation.operation === 'assessAction' && operation.inputSchemaRef && operation.outputSchemaRef), describe);

  const dryRun = await request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      capabilityId: 'security.runtimeGuard',
      operation: 'assessAction',
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
  assert('runtime execute dryRun returns a valid preflight decision', dryRun?.status === 'completed' && dryRun?.result?.valid === true, dryRun);

  const guarded = await request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      capabilityId: 'security.runtimeGuard',
      operation: 'assessAction',
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
    guarded?.result?.schemaVersion === 'anysentry.acp.runtime_guard.result.v1' &&
      ['allow', 'warn', 'require_approval', 'block'].includes(guarded?.result?.policyAction),
    guarded,
  );

  const subscribe = await request('/capabilities?action=subscribe&runId=verify-run');
  assert('runtime subscribe action advertises an event stream bridge', subscribe?.status === 'available' && subscribe?.eventStream?.endpoint, subscribe);

  const approve = await request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({ action: 'approve', runId: 'verify-run', decision: 'approve', approver: 'verifier' }),
  });
  assert('runtime approve action is accepted as local HITL compatibility', approve?.action === 'approve' && approve?.status === 'not_required', approve);
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
