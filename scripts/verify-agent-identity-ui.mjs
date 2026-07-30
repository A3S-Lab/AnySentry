#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, 'utf8');

const identity = read('apps/web/src/components/custom/agent-identity.tsx');
const monitoring = read('apps/web/src/pages/SecurityMonitorPage.tsx');
const events = read('apps/web/src/pages/AgentEventsPage.tsx');
const agents = read('apps/web/src/pages/AgentsPage.tsx');
const topology = read('apps/web/src/pages/TopologyPage.tsx');
const apiTypes = read('apps/web/src/lib/api/security-center.ts');

assert.match(apiTypes, /workloadRef\?: AgentWorkloadRef/u);
assert.match(identity, /confirmed_agent:[\s\S]*text-emerald-200/u);
assert.match(identity, /probable_agent:[\s\S]*text-amber-200/u);
assert.match(identity, /label: "K8s"/u);
assert.match(identity, /label: "Docker"/u);
assert.match(identity, /label: "本地服务"/u);
assert.match(identity, /workload\?\.podName/u);
assert.match(identity, /workload\?\.containerName/u);
assert.match(identity, /workload\?\.systemdUnit/u);
assert.match(monitoring, /<AgentIdentityInline event=\{event\} \/>/u);
assert.doesNotMatch(monitoring, /智能体 \/ 会话/u);
assert.match(events, /<AgentIdentityInline event=\{event\} className="flex" \/>/u);
assert.match(events, /<AgentIdentityInline event=\{event\} showClassification \/>/u);
assert.match(events, /Agent 归因详情/u);
assert.match(events, /Agent 识别证据/u);
assert.match(events, /value=\{workload\?\.podName\}/u);
assert.match(events, /value=\{workload\?\.containerName\}/u);
assert.match(monitoring, /if \(event\.agentId\) qs\.set\("agentId", event\.agentId\)/u);
assert.match(monitoring, /if \(event\.workspacePath\) qs\.set\("workspacePath", event\.workspacePath\)/u);
assert.match(monitoring, /if \(event\.runId\) qs\.set\("runId", event\.runId\)/u);
assert.match(monitoring, /详情 →/u);
assert.match(topology, /const eventQs = new URLSearchParams\(\{ timeType \}\)/u);
assert.match(topology, /查看事件/u);
assert.match(events, /focus: "review"/u);
assert.match(events, /进入资产审核/u);
assert.match(events, /<Link to=\{`\/agents\?\$\{agentQs\.toString\(\)\}`\}>/u);
assert.match(agents, /const \[pendingReview, setPendingReview\]/u);
assert.match(agents, /aria-label="确认人工身份裁决"/u);
assert.match(agents, /确认排除该候选/u);
assert.match(agents, /确认撤销人工结论/u);
assert.doesNotMatch(agents, /window\.confirm/u);
assert.doesNotMatch(agents, /Codex|VS Code/u);
assert.match(agents, /<details className="group rounded-md/u);
assert.match(agents, /身份信息配置/u);
assert.match(agents, /focus"\) === "review"/u);
assert.match(agents, /getElementById\("agent-review"\)\?\.scrollIntoView/u);
assert.match(agents, /返回来源事件/u);
assert.match(agents, /reviewSourceEventId/u);

console.log('Agent identity UI verification passed');
