#!/usr/bin/env node

import assert from 'node:assert/strict';

const baseUrl = (
  process.env.ANYSENTRY_API_BASE
  ?? process.env.API_BASE
  ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`
).replace(/\/$/u, '');
const adminToken = (process.env.ANYSENTRY_ADMIN_TOKEN ?? process.env.ANYSENTRY_MANAGEMENT_TOKEN ?? '').trim();

if (!adminToken) {
  throw new Error('Set ANYSENTRY_ADMIN_TOKEN or ANYSENTRY_MANAGEMENT_TOKEN before running this verifier.');
}

async function request(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { 'x-anysentry-admin-token': token }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const raw = text ? JSON.parse(text) : undefined;
  return { response, raw, payload: raw?.data ?? raw };
}

function assertHumanProjection(value) {
  const forbiddenKeys = new Set([
    'selector',
    'contentHash',
    'eventPolicies',
    'captureIntent',
    'activationGrant',
    'cgroupId',
    'cgroupIds',
  ]);
  const visit = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      assert(!forbiddenKeys.has(key), `human rule projection exposed forbidden field ${key}`);
      visit(child);
    }
  };
  visit(value);
}

const list = await request('/infrastructure-rules/ui/list?limit=5');
assert.equal(list.response.status, 200, `human rule list must load without a browser token: ${JSON.stringify(list.raw)}`);
assert(Array.isArray(list.payload?.items), 'human rule list must return items');
assert.equal(typeof list.payload?.total, 'number');
assert.equal(typeof list.payload?.stateVersion, 'number');
assert.equal(typeof list.payload?.policyVersion, 'number');
assertHumanProjection(list.payload);

const listWithWrongToken = await request('/infrastructure-rules/ui/list?limit=5', { token: 'wrong-management-token' });
assert.equal(listWithWrongToken.response.status, 200, 'an irrelevant stale browser token must not break the public human rule projection');

if (list.payload.items.length) {
  const ruleId = encodeURIComponent(list.payload.items[0].ruleId);
  const detail = await request(`/infrastructure-rules/ui/${ruleId}`);
  assert.equal(detail.response.status, 200, `human rule detail must load without a browser token: ${JSON.stringify(detail.raw)}`);
  assert.equal(detail.payload?.ruleId, list.payload.items[0].ruleId);
  assertHumanProjection(detail.payload);
} else {
  const missingDetail = await request('/infrastructure-rules/ui/verify-missing-rule');
  assert.equal(missingDetail.response.status, 404, 'human rule detail routing must be public and reach the service instead of failing auth');
}

const protectedProbes = [
  { label: 'control status', path: '/infrastructure-rules/status' },
  { label: 'raw policy snapshot', path: '/infrastructure-rules/policy' },
  { label: 'raw rule list', path: '/infrastructure-rules?limit=1' },
  { label: 'operation list', path: '/infrastructure-rules/ui/operations?limit=1' },
  { label: 'operation detail', path: '/infrastructure-rules/ui/operations/verify-missing-operation' },
  { label: 'raw rule detail', path: '/infrastructure-rules/verify-missing-rule' },
  { label: 'materialization report', path: '/infrastructure-rules/materializations/report', method: 'POST', body: {} },
  { label: 'asset-backed draft creation', path: '/infrastructure-rules/drafts/from-asset', method: 'POST', body: {} },
  { label: 'raw rule creation', path: '/infrastructure-rules', method: 'POST', body: {} },
  { label: 'rule validation', path: '/infrastructure-rules/verify-missing-rule/validate', method: 'POST', body: {} },
  { label: 'impact preview', path: '/infrastructure-rules/verify-missing-rule/impact-preview', method: 'POST', body: {} },
  { label: 'shadow transition', path: '/infrastructure-rules/verify-missing-rule/shadow', method: 'POST', body: {} },
  { label: 'promotion', path: '/infrastructure-rules/verify-missing-rule/promote', method: 'POST', body: {} },
  { label: 'revocation', path: '/infrastructure-rules/verify-missing-rule/revoke', method: 'POST', body: {} },
];

for (const probe of protectedProbes) {
  const unauthorized = await request(probe.path, probe);
  assert.equal(
    unauthorized.response.status,
    401,
    `${probe.label} must reject a missing management token: ${JSON.stringify(unauthorized.raw)}`,
  );
}

const wrongRawList = await request('/infrastructure-rules?limit=1', { token: 'wrong-management-token' });
assert.equal(wrongRawList.response.status, 401, 'raw rule list must reject an invalid management token');

const authorizedRawList = await request('/infrastructure-rules?limit=1', { token: adminToken });
assert.equal(authorizedRawList.response.status, 200, `raw rule list must accept the configured management token: ${JSON.stringify(authorizedRawList.raw)}`);
assert(Array.isArray(authorizedRawList.payload?.items));

const authorizedStatus = await request('/infrastructure-rules/status', { token: adminToken });
assert.equal(authorizedStatus.response.status, 200, `control status must accept the configured management token: ${JSON.stringify(authorizedStatus.raw)}`);
assert.equal(typeof authorizedStatus.payload?.rules, 'number');

console.log('PASS capture-rule human reads load without a token while raw control and every mutation remain protected');
