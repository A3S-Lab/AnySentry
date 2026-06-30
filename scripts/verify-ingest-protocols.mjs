#!/usr/bin/env node

import { managementAuthHeaders, safeProbeId } from './probe-id.mjs';

const baseUrl = (process.env.ANYSENTRY_API_BASE ?? process.env.API_BASE ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`).replace(/\/$/, '');

const runId = safeProbeId('ing');

function fail(message, details) {
  console.error(`FAIL ${message}`);
  if (details !== undefined) console.error(JSON.stringify(details, null, 2));
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(message, condition, details) {
  if (condition) pass(message);
  else fail(message, details);
}

async function request(path, method = 'GET', body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...managementAuthHeaders(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return payload?.data ?? payload;
}

function sourceHeaders(sourceId, token, extra = {}) {
  return {
    'x-anysentry-source-id': sourceId,
    'x-anysentry-ingest-token': token,
    ...extra,
  };
}

function assertAccepted(message, result, expectedEvents = 1) {
  assert(
    message,
    result.accepted === true && result.acceptedEvents === expectedEvents && result.rejectedEvents === 0 && result.items?.length === expectedEvents && result.items.every((item) => item.accepted && item.eventId),
    result,
  );
}

function leaks(value, needles) {
  const encoded = JSON.stringify(value);
  return needles.some((needle) => encoded.includes(needle));
}

async function eventById(eventId) {
  const list = await request('/events/list', 'POST', { timeType: 'last_30d', eventId, limit: 5 });
  return { list, event: list.items?.[0] };
}

async function assertEvent(message, eventId, checks) {
  const { list, event } = await eventById(eventId);
  const ok = list.total === 1 && event?.eventId === eventId && checks(event);
  assert(message, ok, list);
}

async function createProtectedSource() {
  const created = await request('/sources', 'POST', {
    name: `${runId} protected webhook`,
    type: 'webhook',
    enabled: true,
    requireToken: true,
    collectorId: `${runId}-collector-protected`,
    workspacePath: `repo://${runId}/protected`,
    owner: 'verify-ingest-protocols',
    tags: [runId, 'protocol-verifier'],
  });
  assert('protected source creation returns token', Boolean(created.source?.sourceId && created.token), created);
  return created;
}

async function verifyTokenRejection(sourceId) {
  const result = await request(
    '/ingest/events',
    'POST',
    {
      sourceName: `${runId} protected webhook`,
      sourceType: 'webhook',
      collectorId: `${runId}-collector-protected`,
      workspacePath: `repo://${runId}/protected`,
      events: [
        {
          kind: 'tool',
          agentId: `${runId}-bad-token-agent`,
          sessionId: `${runId}-bad-token-session`,
          argv: ['id'],
          attributes: { probe: runId, protocol: 'bad-token' },
        },
      ],
    },
    sourceHeaders(sourceId, `${runId}-invalid-token`),
  );

  assert('protected source rejects invalid token', result.accepted === false && result.acceptedEvents === 0 && result.rejectedEvents === 1 && result.items?.[0]?.reason === 'invalid source token', result);

  const sources = await request('/sources/list', 'POST', { sourceId, limit: 5 });
  assert('invalid token increments protected source rejection counter', sources.total === 1 && sources.items?.[0]?.rejectedEvents >= 1 && sources.items?.[0]?.lastResult === 'rejected', sources);
}

async function verifyUnissuedProtectedSourceEnforcesToken() {
  const sourceId = `${runId}-unissued-protected-source`;
  const collectorId = `${runId}-unissued-collector`;
  const workspacePath = `repo://${runId}/unissued-protected`;
  const created = await request(`/sources/${encodeURIComponent(sourceId)}`, 'PUT', {
    name: `${runId} unissued protected source`,
    type: 'webhook',
    enabled: true,
    requireToken: true,
    collectorId,
    workspacePath,
    owner: 'verify-ingest-protocols',
    tags: [runId, 'unissued-protected'],
  });
  assert('protected Source can exist before a token is issued', created.source?.sourceId === sourceId && created.source?.requireToken === true && !created.token, created);

  const collectorRejected = await request('/ingest/events', 'POST', {
    sourceName: `${runId} mismatched unissued source name`,
    sourceType: 'webhook',
    collectorId,
    workspacePath,
    events: [{
      kind: 'tool',
      agentId: `${runId}-unissued-collector-agent`,
      sessionId: `${runId}-unissued-collector-session`,
      argv: ['id'],
      attributes: { probe: runId, protocol: 'unissued-protected-collector' },
    }],
  });
  assert(
    'protected Source without an issued token rejects collector-identity tokenless ingest',
    collectorRejected.accepted === false &&
      collectorRejected.sourceId === sourceId &&
      collectorRejected.acceptedEvents === 0 &&
      collectorRejected.rejectedEvents === 1 &&
      collectorRejected.items?.[0]?.reason === 'source token required',
    collectorRejected,
  );

  const rejected = await request('/ingest/events', 'POST', {
    sourceId,
    sourceName: `${runId} unissued protected source`,
    sourceType: 'webhook',
    collectorId,
    workspacePath,
    events: [{
      kind: 'tool',
      agentId: `${runId}-unissued-agent`,
      sessionId: `${runId}-unissued-session`,
      argv: ['id'],
      attributes: { probe: runId, protocol: 'unissued-protected' },
    }],
  });
  assert(
    'protected Source without an issued token rejects tokenless ingest',
    rejected.accepted === false &&
      rejected.acceptedEvents === 0 &&
      rejected.rejectedEvents === 1 &&
      rejected.items?.[0]?.reason === 'source token required',
    rejected,
  );

  const rejectedSources = await request('/sources/list', 'POST', { sourceId, limit: 5 });
  assert('unissued protected Source records tokenless rejection', rejectedSources.total === 1 && rejectedSources.items?.[0]?.rejectedEvents >= 2 && rejectedSources.items?.[0]?.lastResult === 'rejected', rejectedSources);

  const collectorSources = await request('/sources/list', 'POST', { collectorId, limit: 10 });
  assert(
    'collector-identity rejection does not discover a tokenless bypass Source',
    collectorSources.total === 1 && collectorSources.items?.[0]?.sourceId === sourceId && collectorSources.items?.[0]?.discovered === false,
    collectorSources,
  );

  const rotated = await request(`/sources/${encodeURIComponent(sourceId)}/rotate-token`, 'POST');
  assert('unissued protected Source can recover by rotating a token', rotated.source?.sourceId === sourceId && rotated.token && rotated.source?.tokenRotationStatus === 'fresh', rotated);

  const accepted = await request('/sources/check-in', 'POST', {
    sourceId,
    token: rotated.token,
    sourceName: `${runId} unissued protected source`,
    sourceType: 'webhook',
    collectorId,
    workspacePath,
    status: 'ok',
  });
  assert('rotated token is accepted for previously unissued protected Source', accepted.accepted === true && accepted.sourceId === sourceId, accepted);
}

async function verifyGenericJson(sourceId, token) {
  const agentId = `${runId}-generic-agent`;
  const workspacePath = `repo://${runId}/generic-json`;
  const collectorId = `${runId}-collector-generic`;
  const secret = `${runId}-generic-password`;
  const apiKey = `sk-${runId.replace(/[^a-z0-9]/gi, '').padEnd(18, 'a')}`;
  const result = await request('/ingest/events', 'POST', {
    sourceId,
    token,
    sourceName: `${runId} protected webhook`,
    sourceType: 'custom',
    collectorId,
    workspacePath,
    events: [
      {
        kind: 'tool',
        agentId,
        sessionId: `${runId}-generic-session`,
        runId: `${runId}-generic-run`,
        argv: ['bash', '-lc', `echo anysentry-generic-ok --token=${secret}`],
        cwd: '/workspace',
        rawPreview: `raw preview password=${secret} api_key=${apiKey}`,
        attributes: { probe: runId, protocol: 'generic-json', password: secret, api_key: apiKey, token_count: 123 },
      },
    ],
  });

  assertAccepted('generic JSON ingest accepts tool event', result);
  await assertEvent('generic JSON event preserves source, collector, and agent identity', result.items[0].eventId, (event) =>
    event.eventKind === 'ToolExec' &&
    event.agentId === agentId &&
    event.workspacePath === workspacePath &&
    event.sourceId === sourceId &&
    event.collectorId === collectorId &&
    event.attributes?.sourceId === sourceId &&
    event.attributes?.collectorId === collectorId &&
    event.attributes?.protocol === 'generic-json' &&
    event.attributes?.password === '[redacted]' &&
    event.attributes?.api_key === '[redacted]' &&
    event.attributes?.token_count === 123 &&
    String(event.attributes?.argv ?? '').includes('[redacted]') &&
    String(event.rawPreview ?? '').includes('[redacted]') &&
    !leaks(event, [secret, apiKey]),
  );

  const scoped = await request('/events/list', 'POST', { timeType: 'last_30d', sourceId, collectorId, limit: 10 });
  assert(
    'event Source/Collector filters match promoted event identity',
    scoped.items?.some((event) => event.eventId === result.items[0].eventId && event.sourceId === sourceId && event.collectorId === collectorId),
    scoped,
  );
}

async function verifyStructuredCloudEvent(sourceId, token) {
  const agentId = `${runId}-ce-structured-agent`;
  const workspacePath = `repo://${runId}/ce-structured`;
  const secret = `${runId}-ce-password`;
  const apiKey = `sk-${runId.replace(/[^a-z0-9]/gi, '').padEnd(18, 'b')}`;
  const result = await request('/ingest/events', 'POST', {
    specversion: '1.0',
    id: `${runId}-ce-structured`,
    type: 'com.example.agent.egress',
    source: 'webhook://structured-verifier',
    subject: agentId,
    password: secret,
    sourceId,
    token,
    sourceName: `${runId} structured ce`,
    collectorId: `${runId}-collector-ce-structured`,
    time: new Date().toISOString(),
    data: {
      workspacePath,
      agentId,
      sessionId: `${runId}-ce-structured-session`,
      peer: '203.0.113.10',
      port: 443,
      attributes: { probe: runId, protocol: 'cloudevents-structured', api_key: apiKey, token_count: 456 },
    },
  });

  assertAccepted('structured CloudEvent accepts network event', result);
  await assertEvent('structured CloudEvent preserves envelope evidence without token leakage', result.items[0].eventId, (event) =>
    event.eventKind === 'Egress' &&
    event.agentId === agentId &&
    event.workspacePath === workspacePath &&
    event.attributes?.cloudEventId === `${runId}-ce-structured` &&
    event.attributes?.cloudEventType === 'com.example.agent.egress' &&
    event.attributes?.protocol === 'cloudevents-structured' &&
    event.attributes?.['cloudevents.password'] === '[redacted]' &&
    event.attributes?.api_key === '[redacted]' &&
    event.attributes?.token_count === 456 &&
    event.attributes?.['cloudevents.token'] === undefined &&
    !(event.rawPreview ?? '').includes(token) &&
    !leaks(event, [secret, apiKey]),
  );
}

async function verifyCloudEventDataBase64(sourceId, token) {
  const agentId = `${runId}-ce-base64-agent`;
  const workspacePath = `repo://${runId}/ce-base64`;
  const data = {
    workspacePath,
    agentId,
    sessionId: `${runId}-ce-base64-session`,
    kind: 'dns',
    query: `${runId}.example.test`,
    attributes: { probe: runId, protocol: 'cloudevents-data-base64' },
  };
  const result = await request(
    '/ingest/events',
    'POST',
    {
      specversion: '1.0',
      id: `${runId}-ce-base64`,
      type: 'com.example.agent.dns',
      source: 'webhook://base64-verifier',
      subject: agentId,
      data_base64: Buffer.from(JSON.stringify(data), 'utf8').toString('base64'),
    },
    sourceHeaders(sourceId, token, {
      'x-anysentry-source-name': `${runId} base64 ce`,
      'x-anysentry-collector-id': `${runId}-collector-ce-base64`,
    }),
  );

  assertAccepted('CloudEvents data_base64 accepts decoded JSON event', result);
  await assertEvent('CloudEvents data_base64 event preserves decoded DNS evidence', result.items[0].eventId, (event) =>
    event.eventKind === 'Dns' &&
    event.agentId === agentId &&
    event.workspacePath === workspacePath &&
    event.attributes?.cloudEventDataBase64 === true &&
    event.attributes?.protocol === 'cloudevents-data-base64',
  );
}

async function verifyInvalidCloudEventDataBase64(sourceId, token) {
  const result = await request(
    '/ingest/events',
    'POST',
    {
      specversion: '1.0',
      id: `${runId}-ce-invalid-base64`,
      type: 'com.example.agent.tool',
      source: 'webhook://invalid-base64-verifier',
      subject: `${runId}-invalid-base64-agent`,
      data_base64: 'not-valid-base64%%%',
    },
    sourceHeaders(sourceId, token),
  );

  assert(
    'invalid CloudEvents data_base64 is rejected per event',
    result.accepted === false && result.acceptedEvents === 0 && result.rejectedEvents === 1 && result.items?.[0]?.reason === 'invalid CloudEvents data_base64',
    result,
  );
}

async function verifyBinaryCloudEvent(sourceId, token) {
  const agentId = `${runId}-ce-binary-agent`;
  const workspacePath = `repo://${runId}/ce-binary`;
  const secret = `${runId}-binary-secret`;
  const result = await request(
    '/ingest/events',
    'POST',
    {
      workspacePath,
      agentId,
      sessionId: `${runId}-ce-binary-session`,
      kind: 'file',
      path: `/tmp/${runId}/artifact.txt`,
      attributes: { probe: runId, protocol: 'cloudevents-binary' },
    },
    sourceHeaders(sourceId, token, {
      'ce-specversion': '1.0',
      'ce-id': `${runId}-ce-binary`,
      'ce-type': 'com.example.agent.file',
      'ce-source': 'webhook://binary-verifier',
      'ce-subject': agentId,
      'ce-probe': runId,
      'ce-secret': secret,
    }),
  );

  assertAccepted('binary CloudEvent accepts file event', result);
  await assertEvent('binary CloudEvent preserves header extensions and file evidence', result.items[0].eventId, (event) =>
    event.eventKind === 'FileAccess' &&
    event.agentId === agentId &&
    event.workspacePath === workspacePath &&
    event.attributes?.cloudEventId === `${runId}-ce-binary` &&
    event.attributes?.['cloudevents.probe'] === runId &&
    event.attributes?.['cloudevents.secret'] === '[redacted]' &&
    event.attributes?.protocol === 'cloudevents-binary' &&
    !leaks(event, [secret]),
  );
}

async function verifyCloudEventsBatch(sourceId, token) {
  const agentA = `${runId}-ce-batch-agent-a`;
  const agentB = `${runId}-ce-batch-agent-b`;
  const workspacePath = `repo://${runId}/ce-batch`;
  const result = await request('/ingest/events', 'POST', [
    {
      specversion: '1.0',
      id: `${runId}-ce-batch-a`,
      type: 'com.example.agent.tool',
      source: 'webhook://batch-verifier',
      subject: agentA,
      sourceId,
      token,
      sourceName: `${runId} batch ce`,
      collectorId: `${runId}-collector-ce-batch`,
      workspacePath,
      data: {
        agentId: agentA,
        sessionId: `${runId}-ce-batch-session`,
        argv: ['id'],
        attributes: { probe: runId, protocol: 'cloudevents-batch-a' },
      },
    },
    {
      specversion: '1.0',
      id: `${runId}-ce-batch-b`,
      type: 'com.example.agent.llm',
      source: 'webhook://batch-verifier',
      subject: agentB,
      data: {
        workspacePath,
        agentId: agentB,
        sessionId: `${runId}-ce-batch-session`,
        endpoint: 'openai.test',
        attributes: { probe: runId, protocol: 'cloudevents-batch-b' },
      },
    },
  ]);

  assertAccepted('CloudEvents batch accepts multiple structured events', result, 2);
  await assertEvent('CloudEvents batch first item keeps tool evidence', result.items[0].eventId, (event) =>
    event.eventKind === 'ToolExec' &&
    event.agentId === agentA &&
    event.workspacePath === workspacePath &&
    event.attributes?.cloudEventId === `${runId}-ce-batch-a`,
  );
  await assertEvent('CloudEvents batch second item keeps LLM evidence', result.items[1].eventId, (event) =>
    event.eventKind === 'LlmCall' &&
    event.agentId === agentB &&
    event.workspacePath === workspacePath &&
    event.attributes?.cloudEventId === `${runId}-ce-batch-b`,
  );
}

function otlpAttr(key, value) {
  if (typeof value === 'number') return { key, value: { intValue: String(value) } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: String(value) } };
}

async function verifyOtlpLogs(sourceId, token) {
  const agentId = `${runId}-otel-log-agent`;
  const workspacePath = `repo://${runId}/otel-logs`;
  const password = `${runId}-otel-password`;
  const bodySecret = `${runId}-otel-body-token`;
  const apiKey = `sk-${runId.replace(/[^a-z0-9]/gi, '').padEnd(18, 'c')}`;
  const result = await request(
    '/ingest/otlp/v1/logs',
    'POST',
    {
      sourceId,
      token,
      sourceName: `${runId} otel logs`,
      resourceLogs: [
        {
          resource: {
            attributes: [
              otlpAttr('service.name', agentId),
              otlpAttr('anysentry.workspace', workspacePath),
              otlpAttr('service.instance.id', `${runId}-otel-log-session`),
              otlpAttr('anysentry.collector.id', `${runId}-collector-otel-logs`),
              otlpAttr('service.password', password),
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  traceId: `${runId.replace(/[^a-z0-9]/gi, '').slice(0, 16).padEnd(16, '0')}trace`,
                  spanId: `${runId.replace(/[^a-z0-9]/gi, '').slice(0, 8).padEnd(8, '0')}`,
                  body: { stringValue: `bash -lc echo otel-log-ok authorization: Bearer ${bodySecret}` },
                  attributes: [
                    otlpAttr('anysentry.event.kind', 'tool'),
                    otlpAttr('process.command_line', 'bash -lc echo otel-log-ok'),
                    otlpAttr('probe', runId),
                    otlpAttr('protocol', 'otlp-logs'),
                    otlpAttr('api_key', apiKey),
                    otlpAttr('llm.usage.total_tokens', 42),
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  );

  assertAccepted('OTLP logs endpoint accepts resource log event', result);
  await assertEvent('OTLP logs event derives agent, workspace, collector, and tool command', result.items[0].eventId, (event) =>
    event.eventKind === 'ToolExec' &&
    event.agentId === agentId &&
    event.workspacePath === workspacePath &&
    event.attributes?.collectorId === `${runId}-collector-otel-logs` &&
    event.attributes?.protocol === 'otlp-logs' &&
    event.attributes?.['service.password'] === '[redacted]' &&
    event.attributes?.api_key === '[redacted]' &&
    String(event.attributes?.['log.record.body'] ?? '').includes('[redacted]') &&
    event.attributes?.['llm.usage.total_tokens'] === 42 &&
    !leaks(event, [password, apiKey, bodySecret]),
  );
}

async function verifyOtlpTraces(sourceId, token) {
  const agentId = `${runId}-otel-span-agent`;
  const workspacePath = `repo://${runId}/otel-traces`;
  const result = await request(
    '/ingest/otlp/v1/traces',
    'POST',
    {
      sourceId,
      token,
      sourceName: `${runId} otel traces`,
      resourceSpans: [
        {
          resource: {
            attributes: [
              otlpAttr('service.name', agentId),
              otlpAttr('anysentry.workspace', workspacePath),
              otlpAttr('service.instance.id', `${runId}-otel-span-session`),
              otlpAttr('host.name', `${runId}-otel-host`),
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  name: 'GET https://api.example.test/v1/models',
                  traceId: `${runId.replace(/[^a-z0-9]/gi, '').slice(0, 16).padEnd(16, '1')}trace`,
                  spanId: `${runId.replace(/[^a-z0-9]/gi, '').slice(0, 8).padEnd(8, '1')}`,
                  attributes: [
                    otlpAttr('anysentry.event.kind', 'egress'),
                    otlpAttr('server.address', 'api.example.test'),
                    otlpAttr('server.port', 443),
                    otlpAttr('probe', runId),
                    otlpAttr('protocol', 'otlp-traces'),
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  );

  assertAccepted('OTLP traces endpoint accepts resource span event', result);
  await assertEvent('OTLP traces event derives network evidence from span attributes', result.items[0].eventId, (event) =>
    event.eventKind === 'Egress' &&
    event.agentId === agentId &&
    event.workspacePath === workspacePath &&
    event.attributes?.collectorId === `${runId}-otel-host` &&
    event.attributes?.protocol === 'otlp-traces',
  );
}

async function verifyOtelShortMixed(sourceId, token) {
  const logAgentId = `${runId}-otel-short-log-agent`;
  const spanAgentId = `${runId}-otel-short-span-agent`;
  const logWorkspacePath = `repo://${runId}/otel-short-logs`;
  const spanWorkspacePath = `repo://${runId}/otel-short-traces`;
  const logCollectorId = `${runId}-collector-otel-short-logs`;
  const spanCollectorId = `${runId}-collector-otel-short-traces`;
  const result = await request(
    '/ingest/otel',
    'POST',
    {
      sourceId,
      token,
      sourceName: `${runId} otel short mixed`,
      resourceLogs: [
        {
          resource: {
            attributes: [
              otlpAttr('service.name', logAgentId),
              otlpAttr('anysentry.workspace', logWorkspacePath),
              otlpAttr('service.instance.id', `${runId}-otel-short-log-session`),
              otlpAttr('anysentry.collector.id', logCollectorId),
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  traceId: `${runId.replace(/[^a-z0-9]/gi, '').slice(0, 16).padEnd(16, '2')}trace`,
                  spanId: `${runId.replace(/[^a-z0-9]/gi, '').slice(0, 8).padEnd(8, '2')}`,
                  body: { stringValue: 'bash -lc echo otel-short-log-ok' },
                  attributes: [
                    otlpAttr('anysentry.event.kind', 'tool'),
                    otlpAttr('process.command_line', 'bash -lc echo otel-short-log-ok'),
                    otlpAttr('probe', runId),
                    otlpAttr('protocol', 'otel-short-logs'),
                  ],
                },
              ],
            },
          ],
        },
      ],
      resourceSpans: [
        {
          resource: {
            attributes: [
              otlpAttr('service.name', spanAgentId),
              otlpAttr('anysentry.workspace', spanWorkspacePath),
              otlpAttr('service.instance.id', `${runId}-otel-short-span-session`),
              otlpAttr('host.name', spanCollectorId),
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  name: 'POST https://api.example.test/v1/responses',
                  traceId: `${runId.replace(/[^a-z0-9]/gi, '').slice(0, 16).padEnd(16, '3')}trace`,
                  spanId: `${runId.replace(/[^a-z0-9]/gi, '').slice(0, 8).padEnd(8, '3')}`,
                  attributes: [
                    otlpAttr('anysentry.event.kind', 'egress'),
                    otlpAttr('server.address', 'api.example.test'),
                    otlpAttr('server.port', 443),
                    otlpAttr('probe', runId),
                    otlpAttr('protocol', 'otel-short-traces'),
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  );

  assertAccepted('short OTEL endpoint accepts mixed logs and traces', result, 2);
  await assertEvent('short OTEL endpoint preserves log resource identity', result.items[0].eventId, (event) =>
    event.eventKind === 'ToolExec' &&
    event.agentId === logAgentId &&
    event.workspacePath === logWorkspacePath &&
    event.attributes?.collectorId === logCollectorId &&
    event.attributes?.protocol === 'otel-short-logs',
  );
  await assertEvent('short OTEL endpoint preserves span resource identity', result.items[1].eventId, (event) =>
    event.eventKind === 'Egress' &&
    event.agentId === spanAgentId &&
    event.workspacePath === spanWorkspacePath &&
    event.attributes?.collectorId === spanCollectorId &&
    event.attributes?.protocol === 'otel-short-traces',
  );
}

async function verifySourceRollup(sourceId) {
  const sources = await request('/sources/list', 'POST', { sourceId, limit: 5 });
  const item = sources.items?.[0];
  assert(
    'source rollup records accepted and rejected heterogeneous ingest activity',
    sources.total === 1 && item?.sourceId === sourceId && item.acceptedEvents >= 10 && item.rejectedEvents >= 2 && item.status === 'active',
    sources,
  );
}

async function main() {
  console.log(`AnySentry heterogeneous ingest verification against ${baseUrl}`);
  await request('/stats');
  const { source, token } = await createProtectedSource();
  await verifyTokenRejection(source.sourceId);
  await verifyUnissuedProtectedSourceEnforcesToken();
  await verifyGenericJson(source.sourceId, token);
  await verifyStructuredCloudEvent(source.sourceId, token);
  await verifyCloudEventDataBase64(source.sourceId, token);
  await verifyInvalidCloudEventDataBase64(source.sourceId, token);
  await verifyBinaryCloudEvent(source.sourceId, token);
  await verifyCloudEventsBatch(source.sourceId, token);
  await verifyOtlpLogs(source.sourceId, token);
  await verifyOtlpTraces(source.sourceId, token);
  await verifyOtelShortMixed(source.sourceId, token);
  await verifySourceRollup(source.sourceId);

  if (process.exitCode) {
    console.error(`Heterogeneous ingest verification failed for probe ${runId}`);
    process.exit(process.exitCode);
  }
  console.log(`Heterogeneous ingest verification passed for probe ${runId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
