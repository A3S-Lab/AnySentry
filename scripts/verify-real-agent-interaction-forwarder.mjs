#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (process.env.ANYSENTRY_API_BASE
  ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`).replace(/\/$/u, '');
const observerContainer = process.env.ANYSENTRY_E2E_OBSERVER_CONTAINER
  ?? 'anysentry-observer-tls-diag7';
const observerPod = process.env.ANYSENTRY_E2E_OBSERVER_POD?.trim() ?? '';
const observerNamespace = process.env.ANYSENTRY_E2E_OBSERVER_NAMESPACE?.trim() || 'anysentry';
const marker = process.env.ANYSENTRY_E2E_INTERACTION_MARKER
  ?? 'PI_FINAL_PROMPT_SENTINEL_20260827';
const toolMarker = process.env.ANYSENTRY_E2E_TOOL_INTERACTION_MARKER
  ?? 'ANYSENTRY_TOOL_RESULT:';
const requireToolInteraction = process.env.ANYSENTRY_E2E_REQUIRE_TOOL_INTERACTION === '1';
const runId = safeProbeId('real-interaction-forwarder');

async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...managementAuthHeaders(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
  return payload?.data ?? payload;
}

function observerLogs() {
  const command = observerPod ? 'kubectl' : 'docker';
  const args = observerPod
    ? ['-n', observerNamespace, 'logs', '--since=30m', observerPod]
    : ['logs', '--since', '30m', observerContainer];
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

const observerSource = observerPod
  ? `pod/${observerNamespace}/${observerPod}`
  : `container/${observerContainer}`;

function realInteractionLines() {
  const logs = observerLogs();
  const candidates = [];
  const toolCandidates = [];
  for (const line of logs.split(/\r?\n/u)) {
    if (!line.startsWith('{')) continue;
    try {
      const envelope = JSON.parse(line);
      const interaction = envelope?.event?.LlmInteraction;
      if (
        interaction?.schemaVersion === 'anysentry.agent_interaction.v1'
        && interaction.interactionType === 'tool'
        && interaction.transport === 'tls'
        && interaction.path === '/tool/execute'
        && JSON.stringify(interaction).includes(toolMarker)
      ) {
        toolCandidates.push({ line, envelope, interaction });
      }
      if (
        interaction?.schemaVersion !== 'anysentry.agent_interaction.v1'
        || (interaction.interactionType ?? 'model') !== 'model'
        || interaction.transport !== 'tls'
        || interaction.path !== '/v1/chat/completions'
      ) continue;
      candidates.push({ line, envelope, interaction });
    } catch {
      // Collector diagnostic lines are not NDJSON events.
    }
  }
  const markerPids = new Set(candidates
    .filter(({ interaction }) => JSON.stringify(interaction).includes(marker))
    .map(({ interaction }) => interaction.pid));
  const groups = [...markerPids].map((pid) => candidates
    .filter(({ interaction }) => interaction.pid === pid)
    .sort((left, right) => BigInt(left.interaction.startedAtUnixNs) < BigInt(right.interaction.startedAtUnixNs) ? -1 : 1));
  const selected = groups
    .filter((items) => items.length >= 3)
    .sort((left, right) => BigInt(left.at(-1).interaction.startedAtUnixNs) < BigInt(right.at(-1).interaction.startedAtUnixNs) ? 1 : -1)[0];
  assert.ok(selected, `no complete Pi TLS interaction group found in ${observerSource}`);
  const tool = toolCandidates
    .filter(({ interaction }) => interaction.completeness === 'complete')
    .sort((left, right) => BigInt(left.interaction.startedAtUnixNs) < BigInt(right.interaction.startedAtUnixNs) ? 1 : -1)[0];
  if (requireToolInteraction) {
    assert.ok(tool, `no complete external-tool TLS interaction found in ${observerSource}`);
  }
  return { pi: selected.slice(-3), tool };
}

function runForwarder(lines, source) {
  return new Promise((resolve, reject) => {
    const stderr = [];
    const child = spawn(process.execPath, ['scripts/observer-forward.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ANYSENTRY_INGEST_URL: `${baseUrl}/ingest`,
        ANYSENTRY_BATCH_INGEST_URL: `${baseUrl}/ingest/batch`,
        ANYSENTRY_SOURCE_ID: source.source.sourceId,
        ANYSENTRY_INGEST_TOKEN: source.token,
        ANYSENTRY_SOURCE_NAME: `${runId} real Observer forwarding`,
        ANYSENTRY_SOURCE_TYPE: 'observer',
        ANYSENTRY_WORKSPACE_PATH: `repo://${runId}/workspace`,
        A3S_OBSERVER_COLLECTOR_ID: `${runId}-collector`,
        A3S_NODE_NAME: `${runId}-node`,
        ANYSENTRY_HEARTBEAT_SECS: '0',
        ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0',
        ANYSENTRY_INFRASTRUCTURE_POLICY_SECS: '0',
        ANYSENTRY_FILTER_RULE_PROJECTION_SECS: '0',
        ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_SECS: '300',
        FORWARD_BATCH_FLUSH_MS: '10',
        FORWARD_BATCH_SIZE: '8',
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      if (stderr.join('').length > 64 * 1024) stderr.shift();
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`forwarder exited code=${code} signal=${signal}: ${stderr.join('').slice(-8_000)}`));
    });
    child.stdin.end(`${lines.join('\n')}\n`);
  });
}

const observed = realInteractionLines();
const forwarded = [...observed.pi, ...(observed.tool ? [observed.tool] : [])];
const interactionIds = forwarded.map(({ interaction }) => interaction.interactionId);
assert.equal(new Set(observed.pi.map(({ interaction }) => interaction.pid)).size, 1);
assert.equal(observed.pi.every(({ interaction }) => interaction.completeness === 'complete'), true);

const source = await request('/sources', 'POST', {
  name: `${runId} real Observer source`,
  type: 'observer',
  enabled: true,
  requireToken: true,
  collectorId: `${runId}-collector`,
  workspacePath: `repo://${runId}/workspace`,
  owner: 'verify-real-agent-interaction-forwarder',
  tags: [runId, 'real-observer', 'pi', 'tls'],
});
assert.ok(source.source?.sourceId && source.token);

await runForwarder(forwarded.map(({ line }) => line), source);

const collected = new Map();
const deadline = Date.now() + 15_000;
do {
  for (const interactionId of interactionIds) {
    if (collected.has(interactionId)) continue;
    const list = await request('/agents/interactions', 'POST', {
      timeType: 'last_30d', scope: 'raw', interactionId, limit: 10,
    });
    if (list.items?.[0]) collected.set(interactionId, list.items[0]);
  }
  if (collected.size === interactionIds.length) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
} while (Date.now() < deadline);

assert.equal(collected.size, interactionIds.length, `only ${collected.size}/${interactionIds.length} real interactions reached the API`);
const piItems = observed.pi.map(({ interaction }) => collected.get(interaction.interactionId));
assert.equal(new Set(piItems.map((item) => item.agentAssetId)).size, 1, 'all Pi calls must bind to one Agent asset');
assert.equal(piItems.every((item) => item.interactionType === 'model'), true);
assert.equal(piItems.every((item) => ['confirmed_agent', 'probable_agent'].includes(item.detectedClassification)), true);
assert.equal(piItems.every((item) => item.transport === 'tls' && item.completeness === 'complete'), true);
assert.deepEqual(piItems.flatMap((item) => item.toolCalls.map((call) => call.name)), ['read', 'bash']);
assert.deepEqual(piItems.map((item) => item.toolResults.length), [0, 1, 2]);
assert.ok(piItems[2].response.text?.includes(marker));
assert.ok(piItems[1].toolResults.some((result) => result.toolCallId === 'call_read_fixture'));
assert.ok(piItems[2].toolResults.some((result) => result.toolCallId === 'call_bash_fixture'));

const toolItem = observed.tool ? collected.get(observed.tool.interaction.interactionId) : undefined;
if (toolItem) {
  assert.equal(toolItem.interactionType, 'tool');
  assert.equal(toolItem.path, '/tool/execute');
  assert.equal(toolItem.transport, 'tls');
  assert.equal(toolItem.completeness, 'complete');
  assert.equal(toolItem.captureSource, 'tls_uprobe_tool_route');
  assert.equal(toolItem.request.sha256, observed.tool.interaction.request.sha256);
  assert.equal(toolItem.response.sha256, observed.tool.interaction.response.sha256);
  assert.ok(JSON.stringify(toolItem.request.structured).includes('ANYSENTRY_TOOL_INSTRUCTION'));
  assert.ok(JSON.stringify(toolItem.response.structured).includes(toolMarker));
  assert.equal(toolItem.toolCalls[0]?.name, 'http.tool.execute');
  assert.equal(toolItem.toolResults[0]?.name, 'http.tool.execute');
  assert.ok(BigInt(toolItem.toolResults[0].observedAtUnixNs) >= BigInt(toolItem.toolCalls[0].issuedAtUnixNs));
}
assert.ok(!JSON.stringify([...piItems, toolItem]).toLowerCase().includes('authorization'));

console.log('Real Observer -> Forwarder -> API Agent interaction verification passed');
console.log(JSON.stringify({
  observerSource,
  pid: observed.pi[0].interaction.pid,
  interactions: forwarded.length,
  agentAssetId: piItems[0].agentAssetId,
  agentInstanceIds: [...new Set(piItems.map((item) => item.agentInstanceId ?? null))],
  classification: piItems[0].detectedClassification,
  toolOrder: piItems.flatMap((item) => item.toolCalls.map((call) => call.name)),
  toolResultCounts: piItems.map((item) => item.toolResults.length),
  externalTool: toolItem ? {
    agentAssetId: toolItem.agentAssetId,
    path: toolItem.path,
    requestSha256: toolItem.request.sha256,
    responseSha256: toolItem.response.sha256,
  } : null,
}));
