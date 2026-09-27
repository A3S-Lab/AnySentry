#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const apiSource = readFileSync(`${root}/apps/web/src/lib/api/security-center.ts`, 'utf8');
const agentsSource = readFileSync(`${root}/apps/web/src/pages/AgentsPage.tsx`, 'utf8');
const requireFromWeb = createRequire(`${root}/apps/web/package.json`);
const ts = requireFromWeb('typescript');

const transpiled = ts.transpileModule(apiSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
  fileName: 'security-center.ts',
}).outputText;

const calls = [];
const apiClient = new Proxy({}, {
  get: (_target, method) => (endpoint, body) => {
    const call = { method: String(method), endpoint, body };
    calls.push(call);
    return call;
  },
});
const clientStub = { apiClient, apiRawFetch: () => { throw new Error('not used'); } };
const loaded = { exports: {} };
const execute = new Function('require', 'module', 'exports', transpiled);
execute((id) => {
  if (id === '@/lib/api/client') return clientStub;
  throw new Error(`unexpected module: ${id}`);
}, loaded, loaded.exports);
const client = loaded.exports;

const endpointCall = client.securityCenterApi.agentRuntimeInstances({ includeShadow: true, limit: 4096 });
assert.deepEqual(endpointCall, {
  method: 'post',
  endpoint: '/security-center/runtime/instances',
  body: { includeShadow: true, limit: 4096 },
});

const runtimeA = {
  agentScopeId: 'codex',
  agentInstanceId: 'codex-root-a',
  physicalWorkloadId: 'host-a:root-a',
  runtimeState: 'running',
  activityState: 'active',
};
const runtimeB = {
  agentScopeId: 'codex',
  agentInstanceId: 'codex-root-b',
  physicalWorkloadId: 'host-a:root-b',
  runtimeState: 'exited',
};
const lookup = client.buildAgentRuntimeLookup([runtimeA, runtimeB]);
assert.equal(
  client.matchAgentRuntimeInstance({ agentInstanceId: 'codex-root-a', physicalWorkloadId: 'host-a:root-b' }, lookup),
  runtimeA,
  'agentInstanceId is the primary lifecycle identity',
);
assert.equal(
  client.matchAgentRuntimeInstance({ physicalWorkloadId: 'host-a:root-b' }, lookup),
  runtimeB,
  'a unique physical workload is a safe fallback',
);
assert.equal(
  client.matchAgentRuntimeInstance({ agentId: 'codex' }, lookup),
  undefined,
  'a shared Agent scope must never merge two root lifecycles',
);
assert.doesNotMatch(
  client.matchAgentRuntimeInstance.toString(),
  /agentScopeId/u,
  'runtime association must not consult the display/type scope',
);

const sharedPhysicalLookup = client.buildAgentRuntimeLookup([
  { ...runtimeA, physicalWorkloadId: 'shared-pod' },
  { ...runtimeB, physicalWorkloadId: 'shared-pod' },
]);
assert.equal(
  client.matchAgentRuntimeInstance({ physicalWorkloadId: 'shared-pod' }, sharedPhysicalLookup),
  undefined,
  'an ambiguous physical workload must not collapse multiple Agent instances',
);

const truncatedLookup = client.buildAgentRuntimeLookup([runtimeA], { complete: false });
assert.equal(
  client.matchAgentRuntimeInstance({ physicalWorkloadId: runtimeA.physicalWorkloadId }, truncatedLookup),
  undefined,
  'a truncated API result must disable physical-workload fallback',
);
assert.equal(
  client.matchAgentRuntimeInstance({ agentInstanceId: runtimeA.agentInstanceId }, truncatedLookup),
  runtimeA,
  'exact instance identity remains safe when the API result is truncated',
);

assert.match(apiSource, /export type AgentRuntimeState = "running" \| "exited" \| "lost" \| "unobserved"/u);
assert.match(apiSource, /export type AgentHealthState = "active" \| "idle" \| "stale" \| "risky"/u);
assert.match(apiSource, /export interface AgentRuntimeInstanceRecord \{[\s\S]*?\bleaseEpoch: number;/u);
assert.match(apiSource, /export interface AgentRuntimeInstanceRecord \{[\s\S]*?\bregistryMatcherHash\?: string;/u);
assert.match(apiSource, /healthState: AgentHealthState/u);
assert.match(agentsSource, /securityCenterApi\.agentRuntimeInstances\(\{ includeShadow: true, limit: 4096 \}\)/u);
assert.match(agentsSource, /runtimeData\.total === runtimeData\.items\.length/u);
assert.match(agentsSource, /<RuntimeLifecyclePills runtime=\{runtime\} \/>/u);
assert.match(agentsSource, /<Pill className=\{healthClass\(agent\.healthState\)\}>\{HEALTH_LABEL\[agent\.healthState\]\}<\/Pill>/u);
assert.match(agentsSource, /const \[healthState, setHealthState\]/u);
assert.match(agentsSource, /healthState,/u);
assert.match(agentsSource, /生命周期 ·/u);
assert.match(agentsSource, /活动 ·/u);
assert.match(agentsSource, /runtime \? RUNTIME_STATE_LABEL\[runtime\.runtimeState\] : "未关联"/u);

console.log('Agent runtime lifecycle UI verification passed');
