#!/usr/bin/env node

const internalBase = (process.env.ANYSENTRY_API_BASE ?? ('http://127.0.0.1:' + (process.env.PORT ?? '29653') + '/security-center')).replace(/\/$/, '');
const publicBase = new URL(internalBase).origin + '/api/v1/open/security-center';

const contracts = [
  ['top/healthCard', ['healthScore', 'healthStatusText', 'tokenConsumptionTotal', 'tokenConsumptionUnit']],
  ['top/explainabilityScan', ['waveSeries', 'threatInterception', 'sessionActiveCount', 'updateTime']],
  ['top/performanceCard', ['componentRequestCount', 'tps', 'avgLatency', 'updateTime']],
  ['risks/summary', ['summaryCards', 'updateTime']],
  ['risks/breakdown', ['systemRisks', 'communicationRisks', 'singleAgentRisks', 'updateTime']],
  ['sessions/highestRisk', ['sessionId', 'userId', 'workspacePath', 'riskLevel', 'riskLevelText', 'compositeScore', 'lastEventTime', 'riskDimensions', 'updateTime']],
  ['sessions/decisionFunnel', ['tiers', 'finalBlock', 'updateTime']],
  ['sessions/workspaceRiskDistribution', ['list', 'updateTime']],
];

function fail(message, details) {
  console.error('FAIL ' + message);
  if (details !== undefined) console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2));
  process.exitCode = 1;
}

function pass(message) {
  console.log('PASS ' + message);
}

function assert(message, condition, details) {
  if (condition) pass(message);
  else fail(message, details);
}

async function post(path, body) {
  const res = await fetch(publicBase + '/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  return { res, payload, text };
}

function validSuccessEnvelope(payload) {
  return payload
    && payload.code === 200
    && payload.status === 'SUCCESS'
    && payload.message === '成功'
    && typeof payload.requestId === 'string'
    && payload.requestId.length > 0
    && typeof payload.timestamp === 'string'
    && Number.isFinite(Date.parse(payload.timestamp))
    && payload.data
    && typeof payload.data === 'object';
}

for (const [path, requiredKeys] of contracts) {
  const result = await post(path, { timeType: 'last_3h' });
  assert(path + ' returns HTTP 200', result.res.status === 200, result.payload);
  assert(path + ' returns the Open Platform success envelope', validSuccessEnvelope(result.payload), result.payload);
  assert(
    path + ' data contains every required field',
    requiredKeys.every((key) => Object.hasOwn(result.payload?.data ?? {}, key)),
    { requiredKeys, payload: result.payload },
  );
}

for (const [label, body] of [
  ['nullable timestamps', { timeType: 'last_3h', startTime: null, endTime: null }],
  ['blank timestamps', { timeType: 'last_3h', startTime: '', endTime: '' }],
]) {
  const result = await post('top/healthCard', body);
  assert(label + ' return HTTP 200', result.res.status === 200, result.payload);
  assert(label + ' return the Open Platform success envelope', validSuccessEnvelope(result.payload), result.payload);
}

const invalidType = await post('top/healthCard', { timeType: 'forever' });
assert('invalid timeType returns HTTP 400', invalidType.res.status === 400, invalidType.payload);
assert(
  'invalid timeType returns the Open Platform error envelope',
  invalidType.payload?.code === 400
    && invalidType.payload?.status === 'BAD_REQUEST'
    && typeof invalidType.payload?.message === 'string'
    && typeof invalidType.payload?.requestId === 'string'
    && Number.isFinite(Date.parse(invalidType.payload?.timestamp)),
  invalidType.payload,
);

const reversed = await post('risks/summary', {
  timeType: 'custom',
  startTime: '2026-07-17T03:00:00Z',
  endTime: '2026-07-17T02:00:00Z',
});
assert('reversed custom time window returns HTTP 400', reversed.res.status === 400, reversed.payload);

const internal = await fetch(internalBase + '/top/healthCard', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ timeType: 'last_3h' }),
});
assert('existing internal security-center API remains available', internal.status === 200, await internal.text());

if (process.exitCode) process.exit(process.exitCode);
console.log('Open Platform security-center contract verification passed');
