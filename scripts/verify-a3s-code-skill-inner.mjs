#!/usr/bin/env node

const apiBase = requiredEnv('ANYSENTRY_API_BASE').replace(/\/+$/u, '');
const model = requiredEnv('A3S_TEST_MODEL');
const identity = parseJsonEnv('ANYSENTRY_A3S_CODE_IDENTITY_JSON');
const verifierAttributes = parseJsonEnv('ANYSENTRY_A3S_CODE_VERIFIER_ATTRIBUTES_JSON');
const expectedProgressiveFlow = requiredEnv('ANYSENTRY_A3S_CODE_EXPECTED_PROGRESSIVE_FLOW');
const { runId, agentId, sessionId, workspacePath } = identity;
const flowStartedAt = Date.now();
const flowTimings = {};

for (const [key, value] of Object.entries({ runId, agentId, sessionId, workspacePath })) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`ANYSENTRY_A3S_CODE_IDENTITY_JSON.${key} must be a non-empty string`);
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function parseJsonEnv(name) {
  const value = requiredEnv(name);
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed;
}

async function timed(label, fn) {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    flowTimings[label] = Math.max(0, Date.now() - startedAt);
  }
}

async function request(pathname, init = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} -> HTTP ${response.status}: ${text}`);
  return body?.data ?? body;
}

async function eventually(label, fn) {
  const deadline = Date.now() + 15000;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(lastValue)}`);
}

await timed('innerHealthzMs', () => request('/healthz'));

const modules = await timed('innerListMs', () => request('/capabilities?action=list'));
if (!Array.isArray(modules) || !modules.some((module) => module.name === 'security-center')) {
  throw new Error(`security-center module missing from list: ${JSON.stringify(modules)}`);
}

const operation = await timed('innerDescribeRecordMs', () =>
  request('/capabilities?action=describe&module=security-center&operation=recordSecurityEvents'),
);
if (operation?.name !== 'recordSecurityEvents' || !operation.inputSchema) {
  throw new Error(`recordSecurityEvents describe failed: ${JSON.stringify(operation)}`);
}

const preRecordMs = Math.max(0, Date.now() - flowStartedAt);
flowTimings.innerPreRecordMs = preRecordMs;
const recorded = await timed('innerRecordMs', () =>
  request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      module: 'security-center',
      operation: 'recordSecurityEvents',
      params: {
        sourceName: 'a3s-code-skill-itest',
        sourceType: 'custom',
        workspacePath,
        agentId,
        sessionId,
        events: [
          {
            kind: 'LlmCall',
            workspacePath,
            agentId,
            sessionId,
            runId,
            model,
            subject: 'a3s-code used anysentry-api skill to call progressive API',
            promptTokens: 12,
            completionTokens: 8,
            latencyMs: 321,
            attributes: {
              ...verifierAttributes,
              'progressive.verifier.innerHealthzMs': flowTimings.innerHealthzMs,
              'progressive.verifier.innerListMs': flowTimings.innerListMs,
              'progressive.verifier.innerDescribeRecordMs': flowTimings.innerDescribeRecordMs,
              'progressive.verifier.innerPreRecordMs': preRecordMs,
              'progressive.verifier.healthOk': true,
              'progressive.verifier.listed': true,
              'progressive.verifier.describedOperation': operation.name,
              'progressive.runner': 'a3s-code',
              'progressive.skill': 'anysentry-api',
              'progressive.flow': expectedProgressiveFlow,
              'progressive.model': model,
            },
          },
        ],
      },
    }),
  }),
);

const eventId = recorded.items?.[0]?.eventId;
if (recorded.accepted !== true || !eventId) {
  throw new Error(`recordSecurityEvents did not accept one event: ${JSON.stringify(recorded)}`);
}

const event = await timed('innerQueryEventMs', () =>
  eventually('recorded event to be queryable', async () => {
    const list = await request('/events/list', {
      method: 'POST',
      body: JSON.stringify({ timeType: 'last_30d', runId, agentId, limit: 10 }),
    });
    return list.items?.find(
      (item) =>
        item.eventId === eventId &&
        item.workspacePath === workspacePath &&
        item.runId === runId &&
        item.agentId === agentId &&
        item.sessionId === sessionId,
    );
  }),
);

const bundle = await timed('innerBundleMs', () =>
  request('/capabilities', {
    method: 'POST',
    body: JSON.stringify({
      action: 'execute',
      module: 'security-center',
      operation: 'buildEvidenceBundle',
      params: {
        timeType: 'last_30d',
        eventId,
        limit: 20,
      },
    }),
  }),
);
if (
  bundle?.schemaVersion !== 'anysentry.evidence_bundle.v1' ||
  !bundle.events?.some((item) => item.eventId === eventId) ||
  bundle.primary?.event?.eventId !== eventId
) {
  throw new Error(`buildEvidenceBundle did not include the recorded event: ${JSON.stringify(bundle)}`);
}
flowTimings.innerTotalMs = Math.max(0, Date.now() - flowStartedAt);

console.log(
  JSON.stringify({
    healthOk: true,
    listed: true,
    described: operation.name,
    eventId,
    bundleId: bundle.bundleId,
    bundleSchemaVersion: bundle.schemaVersion,
    bundleContainsEvent: bundle.events?.some((item) => item.eventId === eventId) === true,
    bundleEventCount: bundle.summary?.eventCount,
    bundleListedEventCount: Array.isArray(bundle.events) ? bundle.events.length : undefined,
    bundlePrimaryEventId: bundle.primary?.event?.eventId,
    eventKind: event.eventKind,
    eventCategory: event.eventCategory,
    verdict: event.verdict ?? recorded.items?.[0]?.verdict,
    queriedBack: true,
    timings: flowTimings,
    workspacePath: event.workspacePath,
    runId: event.runId,
    agentId: event.agentId,
    sessionId: event.sessionId,
  }),
);
