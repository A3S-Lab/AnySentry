#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(`${root}/${path}`, 'utf8');

const identity = read('apps/web/src/components/custom/agent-identity.tsx');
const monitoring = read('apps/web/src/pages/SecurityMonitorPage.tsx');
const events = read('apps/web/src/pages/AgentEventsPage.tsx');
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

console.log('Agent identity UI verification passed');
