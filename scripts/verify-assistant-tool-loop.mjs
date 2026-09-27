#!/usr/bin/env node

/**
 * Assistant tool loop: host-side inspect + candidate identity draft.
 * The model is not required. This drives the same stdio MCP server that
 * @a3s-lab/code spawns, then registers it on a code session and calls the tool.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { inspectWorkloads, buildIdentityDraft } = require('./dist/security-monitoring/assistant-workload-tools.js');
const { Agent } = require('@a3s-lab/code');

const source = readFileSync(
  new URL('../apps/api/src/security-monitoring/security-assistant.service.ts', import.meta.url),
  'utf8',
);
assert.match(source, /parseAssistantToolRequest/);
assert.match(source, /maxToolRounds: 1/);
assert.match(source, /defaultDecision: 'deny'/);
assert.match(source, /anysentry-assistant-workspace-/);
assert.match(source, /sessionAsync\(workspaceDir/);
assert.doesNotMatch(source, /sessionAsync\('\.'\)/);
assert.match(source, /TOOL \{"name":"inspect_workloads"/);
assert.match(source, /TOOL \{"name":"apply_identity_rule"/);
assert.match(source, /TOOL \{"name":"explain_rule_decision"/);
assert.match(source, /confirm true only after the user explicitly asks/);

const inspection = inspectWorkloads({
  ready: true,
  generatedAt: '2026-09-22T00:00:00.000Z',
  q: '18082',
  entries: [{
    ids: ['docker:lab'],
    classification: 'unknown',
    physicalWorkloadId: 'docker:pjnl:abc',
    environment: 'docker',
    containerName: 'langchain-lab',
    containerImage: 'python:3.12',
    evidence: ['port 18082'],
  }, {
    ids: ['docker:other'],
    classification: 'non_agent',
    physicalWorkloadId: 'docker:pjnl:def',
    containerName: 'postgres',
    evidence: [],
  }],
  rules: [],
});
assert.equal(inspection.shell, false);
assert.equal(inspection.matched.length, 1);
assert.equal(inspection.matched[0].containerName, 'langchain-lab');
assert.equal(inspection.matched[0].classification, 'unknown');

const preview = buildIdentityDraft({ comm: 'python', container: 'langchain-lab', confirm: false });
assert.equal(preview.persisted, false);
assert.equal(preview.draft.ruleKind, 'agent_template');
assert.equal(preview.draft.effect.classification, 'probable_agent');
assert.equal(preview.draft.effect.confidence, 0.6);
assert.deepEqual(preview.draft.matcher.all, [
  { field: 'workload.container', operator: 'equals', value: 'langchain-lab' },
  { field: 'workload.placement', operator: 'equals', value: 'docker' },
], 'container-scoped drafts route to agent_template; the generic interpreter comm must be ignored');
assert.throws(() => buildIdentityDraft({ comm: 'python', confirm: false }), /generic interpreters/);
assert.throws(() => buildIdentityDraft({ confirm: false }), /one of container, image, comm or exeBasename/);
const signaturePreview = buildIdentityDraft({ comm: 'internal-agent', confirm: false });
assert.equal(signaturePreview.draft.ruleKind, 'runtime_signature');
assert.deepEqual(signaturePreview.draft.matcher.all, [
  { field: 'process.comm', operator: 'equals', value: 'internal-agent' },
]);

const token = randomBytes(16).toString('hex');
const calls = [];
const bridge = createServer((request, response) => {
  if (request.headers['x-anysentry-assistant-tool-token'] !== token) {
    response.writeHead(403);
    response.end('{}');
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const args = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const name = (request.url ?? '').replace(/^\//u, '');
    calls.push(name);
    let body;
    if (name === 'inspect_workloads') {
      body = inspectWorkloads({
        q: args.q,
        ready: true,
        entries: [{
          ids: ['host:python'],
          classification: 'unknown',
          physicalWorkloadId: 'host:python',
          containerName: 'agent-http',
          evidence: ['listen 18082'],
        }],
      });
    } else if (name === 'propose_identity_rule') {
      try {
        const draft = buildIdentityDraft(args);
        body = args.confirm === true
          ? { persisted: true, enforced: false, lifecycleStage: 'draft', authority: 'candidate', ruleId: 'fr_test_draft', name: draft.draft.name }
          : { ...draft, lifecycleStage: 'draft', enforced: false };
      } catch (error) {
        body = { error: error instanceof Error ? error.message : 'invalid draft' };
      }
    } else if (name === 'apply_identity_rule') {
      try {
        const draft = buildIdentityDraft(args);
        body = args.confirm === true
          ? { persisted: true, applied: true, enforced: true, lifecycleStage: 'enforced', authority: 'authoritative', ruleId: 'fr_test_applied', name: draft.draft.name, approvedBy: 'operator' }
          : { applied: false, enforced: false, reason: 'confirm required' };
      } catch (error) {
        body = { error: error instanceof Error ? error.message : 'invalid draft' };
      }
    } else if (name === 'explain_rule_decision') {
      body = {
        subject: { type: 'asset', id: 'docker:pjnl:abc', label: args.container ?? 'agent-http' },
        context: { identityClassification: 'unknown', workloadRole: 'unknown', conflict: false, facts: [] },
        finalOutcome: 'F3: retain_l1_only',
        stages: [{ stage: 'f0', winner: undefined, reason: 'no identity rule matched', failOpen: true, matchedRules: [] }],
        warnings: [],
      };
    } else {
      response.writeHead(404);
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
});
await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
const port = bridge.address().port;

function speak(child) {
  const pending = new Map();
  let next = 1;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const id = next;
    next += 1;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`${method} timed out`)), 5_000);
  });
}

const child = spawn(process.execPath, ['apps/api/dist/security-monitoring/assistant-mcp-server.js'], {
  env: {
    ...process.env,
    ANYSENTRY_ASSISTANT_TOOL_BRIDGE: `http://127.0.0.1:${port}`,
    ANYSENTRY_ASSISTANT_TOOL_TOKEN: token,
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const rpc = speak(child);
const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } });
assert.equal(init.result.serverInfo.name, 'anysentry-assistant');
const listed = await rpc('tools/list', {});
assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['inspect_workloads', 'propose_identity_rule', 'apply_identity_rule', 'explain_rule_decision']);
const inspected = await rpc('tools/call', { name: 'inspect_workloads', arguments: { q: '18082' } });
const inspectedBody = JSON.parse(inspected.result.content[0].text);
assert.equal(inspectedBody.shell, false);
assert.equal(inspectedBody.matched[0].classification, 'unknown');
const previewCall = await rpc('tools/call', { name: 'propose_identity_rule', arguments: { comm: 'python', container: 'agent-http', confirm: false } });
const previewBody = JSON.parse(previewCall.result.content[0].text);
assert.equal(previewBody.persisted, false);
assert.equal(previewBody.enforced, false);
const saved = await rpc('tools/call', { name: 'propose_identity_rule', arguments: { comm: 'python', container: 'agent-http', confirm: true } });
const savedBody = JSON.parse(saved.result.content[0].text);
assert.equal(savedBody.persisted, true);
assert.equal(savedBody.enforced, false);
assert.equal(savedBody.lifecycleStage, 'draft');
const applied = await rpc('tools/call', { name: 'apply_identity_rule', arguments: { comm: 'python', container: 'agent-http', confirm: true } });
const appliedBody = JSON.parse(applied.result.content[0].text);
assert.equal(appliedBody.persisted, true);
assert.equal(appliedBody.enforced, true);
assert.equal(appliedBody.lifecycleStage, 'enforced');
const unconfirmed = await rpc('tools/call', { name: 'apply_identity_rule', arguments: { container: 'agent-http', confirm: false } });
assert.equal(JSON.parse(unconfirmed.result.content[0].text).enforced, false);
const genericOnly = await rpc('tools/call', { name: 'apply_identity_rule', arguments: { comm: 'python', confirm: true } });
assert.match(JSON.parse(genericOnly.result.content[0].text).error ?? '', /generic interpreters/);
const explained = await rpc('tools/call', { name: 'explain_rule_decision', arguments: { container: 'agent-http' } });
const explainedBody = JSON.parse(explained.result.content[0].text);
assert.equal(explainedBody.subject.label, 'agent-http');
assert.equal(explainedBody.finalOutcome, 'F3: retain_l1_only');
assert.deepEqual(calls, ['inspect_workloads', 'propose_identity_rule', 'propose_identity_rule', 'apply_identity_rule', 'apply_identity_rule', 'apply_identity_rule', 'explain_rule_decision']);
child.kill();
await once(child, 'exit');

const agent = await Agent.create([
  'id = "anysentry-assistant-tool-loop"',
  'name = "AnySentry assistant tool loop"',
  'default_model = "openai/verify-model"',
  'providers "openai" {',
  '  id = "openai"',
  '  name = "openai"',
  '  models "verify-model" {',
  '    id = "verify-model"',
  '    name = "verify-model"',
  '    apiKey = "verify"',
  '    baseUrl = "http://127.0.0.1:9/v1"',
  '  }',
  '}',
].join('\n'));
const session = await agent.sessionAsync('.', {
  planningMode: 'disabled',
  permissionPolicy: {
    enabled: true,
    allow: ['mcp__anysentry__inspect_workloads', 'mcp__anysentry__propose_identity_rule'],
    defaultDecision: 'deny',
  },
  maxToolRounds: 4,
  autoParallel: false,
  manualDelegationEnabled: false,
});
const registered = await session.addMcpServer(
  'anysentry',
  'stdio',
  process.execPath,
  ['apps/api/dist/security-monitoring/assistant-mcp-server.js'],
  null,
  null,
  {
    ANYSENTRY_ASSISTANT_TOOL_BRIDGE: `http://127.0.0.1:${port}`,
    ANYSENTRY_ASSISTANT_TOOL_TOKEN: token,
  },
  8_000,
);
assert.equal(registered, 4, 'code session must register all four assistant tools');
const names = session.toolNames();
assert.ok(names.includes('mcp__anysentry__inspect_workloads'));
assert.ok(names.includes('mcp__anysentry__explain_rule_decision'));
assert.ok(names.includes('mcp__anysentry__propose_identity_rule'));
const direct = await session.tool('mcp__anysentry__inspect_workloads', { q: '18082' });
assert.equal(direct.exitCode, 0);
assert.match(direct.output, /"shell":false/);
assert.match(direct.output, /agent-http/);
const denied = await session.tool('bash', { command: 'id' });
assert.notEqual(denied.exitCode, 0);
await session.closeAsync();
await agent.close();
await new Promise((resolve) => bridge.close(resolve));

console.log('verify-assistant-tool-loop: ok');
