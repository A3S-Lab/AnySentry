#!/usr/bin/env node

import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';

import { SecurityAssistantService } from '../apps/api/dist/security-monitoring/security-assistant.service.js';
import { ObserverInventoryService } from '../apps/api/dist/security-monitoring/observer-inventory.service.js';

const aggregation = {
  healthCardForWindow: () => ({ healthScore: 99 }),
  riskSummaryForWindow: () => ({ total: 0 }),
  decisionFunnelForWindow: () => ({ observed: 0 }),
  agentEventsForWindow: () => ({ items: [] }),
  incidents: () => ({ items: [] }),
};
const alerting = { list: () => ({ items: [] }) };
const streamFindings = { list: () => ({ compositeJudgments: [] }) };
const supplyChain = { overview: () => ({ findings: [] }) };
const systemContext = { build: async () => { throw new Error('unused'); } };
const kube = {
  snapshot: () => ({
    ready: true,
    generatedAt: '2026-09-23T00:00:00.000Z',
    entries: [{
      ids: ['host:python'],
      classification: 'unknown',
      physicalWorkloadId: 'host:python',
      containerName: 'agent-http',
      evidence: ['listen 18082'],
    }],
  }),
};
const filterRules = { list: () => ({ items: [] }) };

function service() {
  return new SecurityAssistantService(
    aggregation,
    alerting,
    streamFindings,
    supplyChain,
    systemContext,
    kube,
    filterRules,
    new ObserverInventoryService(),
    { get: () => null },
  );
}

async function missing(dir) {
  await assert.rejects(access(dir), { code: 'ENOENT' });
}

function install(target, sessionFactory) {
  const agent = { sessionAsync: sessionFactory, close: async () => undefined };
  // getAgent caches by resolved model config; align the stub with the current key.
  const key = target.resolveModelConfig().cacheKey;
  target.agent = agent;
  target.agentKey = key;
  target.initialization = Promise.resolve(agent);
  target.initializationKey = key;
  return target;
}

const direct = install(service(), async (workspace, options) => {
  assert.match(workspace, /anysentry-assistant-workspace-/);
  assert.equal(isAbsolute(workspace), true);
  await access(workspace);
  assert.deepEqual(await readdir(workspace), []);
  const memoryRoot = options.memoryStore?.dir ?? options.memoryStore?.root;
  assert.equal(typeof memoryRoot, 'string');
  assert.match(memoryRoot, /anysentry-assistant-memory-/);
  assert.equal(relative(workspace, memoryRoot).startsWith(`..${sep}`) || relative(workspace, memoryRoot).startsWith('..'), true);
  assert.equal(options.externalObservations, undefined);
  assert.equal(options.permissionPolicy.defaultDecision, 'deny');
  await access(memoryRoot);
  return {
    async send() {
      await access(workspace);
      await access(memoryRoot);
      return { text: '[FINAL_ANSWER] 工作区检查通过', totalTokens: 3 };
    },
    async cancelAsync() {},
    async closeAsync() {
      await access(workspace);
    },
  };
});
const answer = await direct.answer({ question: '只回答一句', locale: 'zh-CN' });
assert.match(answer.answer, /工作区检查通过/);
assert.equal(direct.scratchDirs.size, 0);
assert.equal(direct.active, 0);

const failedDirs = [];
const failed = install(service(), async (workspace) => {
  failedDirs.push(workspace);
  await access(workspace);
  return {
    async send() {
      throw new Error('model down');
    },
    async cancelAsync() {},
    async closeAsync() {},
  };
});
await assert.rejects(failed.answer({ question: '失败也要删目录' }), /model down/);
assert.equal(failedDirs.length, 1);
await missing(failedDirs[0]);
assert.equal(failed.scratchDirs.size, 0);
assert.equal(failed.active, 0);
const again = await install(failed, async () => ({
  async send() {
    return { text: '[FINAL_ANSWER] 并发槽已释放', totalTokens: 1 };
  },
  async cancelAsync() {},
  async closeAsync() {},
})).answer({ question: '槽位恢复' });
assert.match(again.answer, /并发槽已释放/);

const toolWorkspaces = [];
const tooled = install(service(), async (workspace) => {
  toolWorkspaces.push(workspace);
  let round = 0;
  return {
    async send() {
      await access(workspace);
      round += 1;
      if (round === 1) return { text: 'TOOL {"name":"inspect_workloads","arguments":{"q":"18082"}}', totalTokens: 2 };
      return { text: '[FINAL_ANSWER] 看到 agent-http', totalTokens: 2 };
    },
    async cancelAsync() {},
    async closeAsync() {},
  };
});
const toolAnswer = await tooled.answer({ question: '看一下 18082', locale: 'zh-CN' });
assert.equal(toolAnswer.toolCalls.length, 1);
assert.equal(toolAnswer.toolCalls[0].name, 'inspect_workloads');
assert.match(toolAnswer.answer, /agent-http/);
assert.equal(toolWorkspaces.length, 1);
await missing(toolWorkspaces[0]);
assert.equal(tooled.scratchDirs.size, 0);

let releaseSend;
const shutdown = install(service(), async (workspace) => {
  return {
    async send() {
      await new Promise((resolve) => {
        releaseSend = resolve;
      });
      await missing(workspace);
      return { text: '[FINAL_ANSWER] 关闭后目录已删除', totalTokens: 1 };
    },
    async cancelAsync() {},
    async closeAsync() {},
  };
});
const pending = shutdown.answer({ question: '关闭清理' });
for (let i = 0; i < 50 && typeof releaseSend !== 'function'; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(typeof releaseSend, 'function');
assert.equal(shutdown.scratchDirs.size, 2);
const liveDirs = [...shutdown.scratchDirs];
await shutdown.onModuleDestroy();
assert.equal(shutdown.scratchDirs.size, 0);
for (const dir of liveDirs) await missing(dir);
releaseSend();
const shutdownAnswer = await pending;
assert.match(shutdownAnswer.answer, /关闭后目录已删除/);
const leftovers = (await readdir(tmpdir())).filter((name) => name.startsWith('anysentry-assistant-workspace-') || name.startsWith('anysentry-assistant-memory-'));
assert.deepEqual(leftovers.filter((name) => liveDirs.some((dir) => dir.endsWith(name))), []);

console.log('verify-assistant-workspace-lifecycle: ok');
