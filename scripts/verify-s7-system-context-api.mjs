#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (
  process.env.ANYSENTRY_API_BASE ?? process.env.API_BASE ??
  `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`
).replace(/\/$/u, '');
const runId = safeProbeId('s7-context-api');
const assistantModel = process.env.A3S_SENTRY_ASSISTANT_MODEL ?? 's7-context-model';
const assistantMockPort = Number(process.env.ANYSENTRY_S7_ASSISTANT_MOCK_PORT ?? 18061);
const assistantRequests = [];

async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function modelPrompt(body) {
  return (Array.isArray(body?.messages) ? body.messages : []).flatMap((message) => {
    if (typeof message?.content === 'string') return [message.content];
    if (!Array.isArray(message?.content)) return [];
    return message.content.flatMap((item) => typeof item?.text === 'string' ? [item.text] : []);
  }).join('\n');
}

const assistantServer = createServer(async (incoming, response) => {
  try {
    if (incoming.method === 'GET' && incoming.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ object: 'list', data: [{ id: assistantModel, object: 'model' }] }));
      return;
    }
    if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    const body = await requestJson(incoming);
    assert.equal(body.model, assistantModel);
    assistantRequests.push(body);
    const answer = '[FINAL_ANSWER] 已使用有界 System Context 完成只读风险分析。';
    if (body.stream === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(`data: ${JSON.stringify({
        id: 's7-assistant-context', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1_000),
        model: assistantModel, choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: 's7-assistant-context', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1_000),
        model: assistantModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      id: 's7-assistant-context', object: 'chat.completion', created: Math.floor(Date.now() / 1_000),
      model: assistantModel,
      choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 64, completion_tokens: 16, total_tokens: 80 },
    }));
  } catch (error) {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : String(error));
  }
});

async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...managementAuthHeaders(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : undefined; } catch { payload = raw; }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${raw}`);
  return payload?.data ?? payload;
}

async function createSource(input) {
  const result = await request('/sources', 'POST', {
    enabled: true,
    requireToken: true,
    owner: 'verify-s7-system-context-api',
    ...input,
  });
  assert(result.source?.sourceId && result.token);
  return result;
}

function sourceHeaders(source) {
  return {
    'x-anysentry-source-id': source.source.sourceId,
    'x-anysentry-ingest-token': source.token,
  };
}

await new Promise((resolve, reject) => {
  assistantServer.once('error', reject);
  assistantServer.listen(assistantMockPort, '127.0.0.1', resolve);
});

try {

const workspacePath = `/workspace/${runId}`;
const collectorId = `${runId}-collector`;
const observer = await createSource({
  name: `${runId} Observer`, type: 'observer', collectorId, workspacePath,
  correlationClaims: {
    enabled: true, authority: 'observer_runtime', bindings: { collectorIds: [collectorId] },
  },
});
const contextSource = await createSource({
  name: `${runId} Context`, type: 'otel', workspacePath, tags: ['system-context'],
});
const otherWorkspacePath = `${workspacePath}-other`;
const otherContextSource = await createSource({
  name: `${runId} Other Context`, type: 'otel', workspacePath: otherWorkspacePath, tags: ['system-context'],
});
const ordinarySource = await createSource({
  name: `${runId} Ordinary`, type: 'custom', workspacePath, tags: [],
});
const unboundContextSource = await createSource({
  name: `${runId} Unbound Context`, type: 'otel', tags: ['system-context'],
});

const pid = 72_001;
const startTicks = '810001';
const agentScopeId = `${runId}-agent`;
const processContext = {
  hostId: `${runId}-host`, bootId: `${runId}-boot`, pid, ppid: 1,
  startTimeTicks: startTicks, comm: 'codex', exe: '/usr/local/bin/codex', cwd: workspacePath,
  cgroup: `/docker/${'8'.repeat(64)}`, cgroupId: `${runId}-agent-cgroup`,
};
const observerLine = JSON.stringify({
  identity: { agent: agentScopeId, session: `${runId}-session`, task: pid },
  process: processContext,
  event: { ToolExec: { pid, ppid: 1, uid: 1000, cwd: workspacePath, argv: ['codex', 'exec', 'context-probe'] } },
});
const agentIngest = await request('/ingest', 'POST', {
  line: observerLine,
  sourceEventId: `${runId}-agent-root`,
  collectorId,
  sourceType: 'observer',
  workspacePath,
  process: processContext,
  attribution: {
    monitored: true, classification: 'confirmed_agent', agentScopeId, agentDisplayName: 'Codex context probe',
    agentSessionId: `${runId}-session`, agentInstanceId: `${agentScopeId}:${pid}:${startTicks}`,
    rootKey: `${processContext.hostId}:${processContext.bootId}:${pid}:${startTicks}`,
    physicalWorkloadId: `${runId}-agent-workload`,
    workloadRef: { environment: 'docker', kind: 'container', name: 'agent', containerName: 'agent' },
    rootPid: pid, rootStartTime: startTicks, confidence: 1,
    reason: 'authoritative_anchor', source: 'process_graph', evidence: ['observer:verified-runtime-root'],
  },
}, sourceHeaders(observer));
assert(agentIngest.accepted && agentIngest.eventId);

let agent;
const inventoryDeadline = Date.now() + 5_000;
do {
  const inventory = await request('/agents/inventory', 'POST', {
    timeType: 'last_30d', scope: 'raw', agentId: agentScopeId, workspacePath, limit: 20,
  });
  agent = inventory.items?.find((item) => item.agentId === agentScopeId);
  if (agent) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
} while (Date.now() < inventoryDeadline);
assert(agent?.agentAssetId, 'Agent asset is available for context focus');

function contextEvent(id, factType, attributes) {
  return {
    id: `${runId}-${id}`,
    at: Date.now(),
    kind: 'SystemContext',
    eventCategory: 'runtime',
    workspacePath,
    agentId: 'system-context-source',
    sessionId: `${runId}-context-session`,
    userId: 'system',
    subject: `${factType} context`,
    attributes: {
      'context.fact.type': factType,
      'context.source.kind': 'otel',
      'context.association.confidence': 0.99,
      'context.association.method': 'exact_resource_identity',
      ...attributes,
    },
  };
}

const ordinaryAttempt = await request('/ingest/events', 'POST', {
  sourceId: ordinarySource.source.sourceId,
  sourceType: 'custom',
  workspacePath,
  events: [{
    ...contextEvent('ordinary-forgery', 'metric', {
      'context.metric.resource_id': 'service:business-api',
      'context.metric.name': 'forged.metric',
      'context.metric.value': 999,
    }),
    kind: 'system_context',
  }],
}, sourceHeaders(ordinarySource));
assert.equal(ordinaryAttempt.acceptedEvents, 0, 'managed Source without system-context capability cannot write facts');
assert.match(ordinaryAttempt.items[0].reason, /tagged system-context/u);

const unboundAttempt = await request('/ingest/events', 'POST', {
  sourceId: unboundContextSource.source.sourceId,
  sourceType: 'otel',
  workspacePath,
  events: [contextEvent('unbound-workspace-forgery', 'metric', {
    'context.metric.resource_id': 'service:business-api',
    'context.metric.name': 'must.require.exact.workspace.binding',
    'context.metric.value': 666,
  })],
}, sourceHeaders(unboundContextSource));
assert.equal(unboundAttempt.acceptedEvents, 0, 'a system-context Source without exact workspace binding is rejected');
assert.match(unboundAttempt.items[0].reason, /workspace-bound/u);

const crossWorkspaceForgery = await request('/ingest/events', 'POST', {
  sourceId: otherContextSource.source.sourceId,
  sourceType: 'otel',
  workspacePath: otherWorkspacePath,
  events: [contextEvent('cross-workspace-forgery', 'metric', {
    'context.metric.resource_id': 'service:business-api',
    'context.metric.name': 'must.not.cross.workspace.binding',
    'context.metric.value': 777,
  })],
}, sourceHeaders(otherContextSource));
assert.equal(crossWorkspaceForgery.acceptedEvents, 0, 'a tagged Source cannot override its workspace per event');
assert.match(crossWorkspaceForgery.items[0].reason, /workspace-bound/u);

const otherWorkspaceFact = await request('/ingest/events', 'POST', {
  sourceId: otherContextSource.source.sourceId,
  sourceType: 'otel',
  workspacePath: otherWorkspacePath,
  events: [{
    ...contextEvent('other-workspace-metric', 'metric', {
      'context.metric.resource_id': 'service:business-api',
      'context.metric.name': 'must.not.cross.workspace.query',
      'context.metric.value': 888,
    }),
    workspacePath: otherWorkspacePath,
  }],
}, sourceHeaders(otherContextSource));
assert.equal(otherWorkspaceFact.acceptedEvents, 1);
const unknownBeforeContext = await request('/unknown-learning/status');

const facts = [
  contextEvent('agent-resource', 'resource', {
    'context.resource.id': `${runId}-agent-workload`,
    'context.resource.kind': 'agent_runtime',
    'context.resource.role': 'agent',
    'context.resource.name': 'codex-agent',
    'context.resource.physical_workload_id': `${runId}-agent-workload`,
  }),
  contextEvent('business-resource', 'resource', {
    'context.resource.id': 'service:business-api',
    'context.resource.kind': 'service',
    'context.resource.role': 'business_service',
    'context.resource.name': 'business-api',
  }),
  contextEvent('db-resource', 'resource', {
    'context.resource.id': 'database:clickhouse',
    'context.resource.kind': 'database',
    'context.resource.role': 'platform_infrastructure',
    'context.resource.name': 'clickhouse',
  }),
  contextEvent('agent-business-edge', 'dependency', {
    'context.dependency.edge_id': 'edge:agent-business',
    'context.dependency.source_resource_id': `${runId}-agent-workload`,
    'context.dependency.target_resource_id': 'service:business-api',
    'context.dependency.relation': 'calls',
    'context.dependency.event_count': 50,
    'context.dependency.aggregated': true,
  }),
  contextEvent('business-db-edge', 'dependency', {
    'context.dependency.edge_id': 'edge:business-db',
    'context.dependency.source_resource_id': 'service:business-api',
    'context.dependency.target_resource_id': 'database:clickhouse',
    'context.dependency.relation': 'queries',
    'context.dependency.event_count': 200,
    'context.dependency.aggregated': true,
  }),
  contextEvent('business-metric', 'metric', {
    'context.metric.id': 'metric:business-errors',
    'context.metric.resource_id': 'service:business-api',
    'context.metric.name': 'http.server.error_rate',
    'context.metric.value': 0.23,
    'context.metric.unit': 'ratio',
    'context.metric.kind': 'rate',
    'context.metric.status': 'anomalous',
  }),
  contextEvent('business-change', 'change', {
    'context.change.id': 'change:business-v42',
    'context.change.resource_ids': 'service:business-api',
    'context.change.type': 'deployment',
    'context.change.summary': 'business-api rolled out v42',
  }),
  contextEvent('business-alert', 'alert', {
    'context.alert.id': 'alert:business-errors',
    'context.alert.resource_ids': 'service:business-api',
    'context.alert.title': 'business-api error rate high',
    'context.alert.severity': 'high',
    'context.alert.status': 'open',
  }),
];
const factsIngest = await request('/ingest/events', 'POST', {
  sourceId: contextSource.source.sourceId,
  sourceType: 'otel',
  workspacePath,
  events: facts,
}, sourceHeaders(contextSource));
if (factsIngest.acceptedEvents !== facts.length) {
  console.error(JSON.stringify({ contextSource: contextSource.source, factsIngest }, null, 2));
}
assert.equal(factsIngest.acceptedEvents, facts.length);
const metricTimeUnixNano = String(BigInt(Date.now()) * 1_000_000n);
const otlpMetricsIngest = await request('/ingest/otlp/v1/metrics', 'POST', {
  sourceId: contextSource.source.sourceId,
  sourceType: 'otel',
  workspacePath,
  resourceMetrics: [{
    resource: { attributes: [
      { key: 'service.name', value: { stringValue: 'business-api' } },
      { key: 'service.namespace', value: { stringValue: 'production' } },
      { key: 'deployment.environment.name', value: { stringValue: 'test' } },
      { key: 'anysentry.service.asset.id', value: { stringValue: 'service:business-api' } },
      { key: 'anysentry.workload.role', value: { stringValue: 'business_service' } },
    ] },
    scopeMetrics: [{ metrics: [{
      name: 'http.server.request.error_rate', unit: '1', gauge: { dataPoints: [{
        timeUnixNano: metricTimeUnixNano, asDouble: 0.17,
        attributes: [{ key: 'anysentry.metric.status', value: { stringValue: 'anomalous' } }],
      }] },
    }, {
      name: 'http.server.request.duration', unit: 'ms', histogram: { dataPoints: [{
        timeUnixNano: metricTimeUnixNano, count: '100', sum: 4200,
        explicitBounds: [10, 25, 50, 100, 250], bucketCounts: ['10', '30', '40', '15', '5', '0'],
      }] },
    }] }],
  }],
}, sourceHeaders(contextSource));
assert.equal(otlpMetricsIngest.acceptedEvents, 3, 'one OTel Service resource and two real metric facts are accepted');
const unknownAfterContext = await request('/unknown-learning/status');
if (unknownBeforeContext.enabled) {
  assert.equal(
    unknownAfterContext.dedupeEntries,
    unknownBeforeContext.dedupeEntries,
    'SystemContext facts do not consume bounded Unknown-learning dedupe capacity',
  );
}

const contextWindowStart = new Date(Date.now() - 60 * 60_000).toISOString();
const contextWindowEnd = new Date(Date.now() + 1_000).toISOString();
const bundle = await request('/context/system', 'POST', {
  timeType: 'custom',
  startTime: contextWindowStart,
  endTime: contextWindowEnd,
  agentAssetId: agent.agentAssetId,
  agentInstanceId: agent.agentInstanceId,
});
assert.equal(bundle.schemaVersion, 'anysentry.system_context_bundle.v1');
assert.equal(bundle.focus.agentAssetId, agent.agentAssetId);
assert(bundle.relatedResources.some((item) => item.resourceId === 'service:business-api'));
assert(bundle.relatedResources.some((item) => item.resourceId === 'database:clickhouse'));
assert.deepEqual(bundle.dependencies
  .filter((item) => item.edgeId.startsWith('edge:'))
  .map((item) => item.edgeId), ['edge:agent-business', 'edge:business-db']);
assert(bundle.metrics.some((item) => item.name === 'http.server.error_rate' && item.status === 'anomalous'));
assert(bundle.metrics.some((item) => item.name === 'http.server.request.error_rate' && item.status === 'anomalous'));
assert(bundle.metrics.some((item) => item.name === 'http.server.request.duration.p95' && item.value === 100));
assert(!bundle.metrics.some((item) => item.name.startsWith('must.not.cross.workspace')));
assert(bundle.alerts.some((item) => item.alertId === 'alert:business-errors' && item.severity === 'high'));
assert(bundle.changes.some((item) => item.changeId === 'change:business-v42'));
assert.equal(bundle.summary.businessServiceCount, 1);
assert.equal(bundle.summary.maxTopologyHop, 2);
assert(bundle.quality.sources.some((item) => item.domain === 'metrics'));

const storedFact = await request('/events/list', 'POST', {
  timeType: 'last_30d', scope: 'raw', noise: 'include', eventId: factsIngest.items[0].eventId, limit: 1,
});
assert.equal(storedFact.items[0].attribution.classification, 'non_agent');
assert.equal(storedFact.items[0].attribution.evidence[0], 'server:authenticated-system-context-source');

const agentOnlyInventory = await request('/agents/inventory', 'POST', {
  timeType: 'last_30d', scope: 'agent', workspacePath, limit: 100,
});
assert.equal(
  agentOnlyInventory.items.some((item) => item.agentId === 'system-context-source'),
  false,
  'SystemContext producer identities do not become Agent assets',
);

const assistant = await request('/assistant/query', 'POST', {
  question: '结合业务服务指标和变更分析这个 Agent 当前风险。',
  locale: 'zh-CN',
  context: {
    path: `/agents?agentAssetId=${encodeURIComponent(agent.agentAssetId)}`,
    timeType: 'custom',
    startTime: contextWindowStart,
    endTime: contextWindowEnd,
    agentId: agentScopeId,
    agentAssetId: agent.agentAssetId,
    agentInstanceId: agent.agentInstanceId,
    workspacePath,
    traceId: agentIngest.traceId,
  },
});
assert.equal(assistant.readOnly, true);
assert.equal(assistant.model, assistantModel);
assert.match(assistant.answer, /有界 System Context/u);
assert.equal(assistant.systemContext.requested, true);
assert.equal(assistant.systemContext.agentAssetId, agent.agentAssetId);
assert.match(assistant.systemContext.bundleId, /^scb_[a-f0-9]{24}$/u);
assert(['complete', 'partial'].includes(assistant.systemContext.status));
assert(assistant.systemContext.estimatedBytes <= 64 * 1_024);
assert(assistant.references.some((reference) => reference.id === assistant.systemContext.bundleId));
const scopedPrompt = modelPrompt(assistantRequests.at(-1));
assert(scopedPrompt.includes('anysentry.system_context_bundle.v1'), 'the bounded Bundle reaches the actual model request');
assert(scopedPrompt.includes('http.server.error_rate'), 'business-service metrics reach risk analysis');
assert(scopedPrompt.includes('business-api rolled out v42'), 'deployment context reaches risk analysis');
assert(scopedPrompt.includes(`"maxHops":2`), 'the model-visible Bundle retains the two-hop bound');
assert(scopedPrompt.includes(`"maxBytes":65536`), 'the model-visible Bundle retains the Assistant byte budget');
assert(scopedPrompt.includes(contextWindowStart) && scopedPrompt.includes(contextWindowEnd), 'the selected time window reaches risk analysis unchanged');
assert(scopedPrompt.includes(workspacePath), 'the exact Agent workspace remains bound in the model-visible context');
assert(scopedPrompt.includes(agentIngest.traceId), 'legacy Trace remains an unchanged page selector');

const unscopedAssistant = await request('/assistant/query', 'POST', {
  question: '当前是否有足够的 Agent 上下文？',
  locale: 'zh-CN',
  context: { path: '/', timeType: 'last_3h' },
});
assert.deepEqual(unscopedAssistant.systemContext, {
  status: 'partial', requested: false, reasonCodes: ['agent_asset_not_selected'],
});
assert(modelPrompt(assistantRequests.at(-1)).includes('agent_asset_not_selected'));

console.log('S7 authenticated System Context API E2E passed');
} finally {
  await new Promise((resolve, reject) => assistantServer.close((error) => error ? reject(error) : resolve()));
}
