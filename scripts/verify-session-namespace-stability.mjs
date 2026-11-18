import assert from 'node:assert/strict';
import { RelationalBusinessStore } from '../apps/api/dist/security-monitoring/relational-business-store.service.js';

// Exercise the durable lookup independently of ClickHouse and without modifying a database.
const complete = { bindingId: 'complete', hostId: 'host', bootId: 'boot',
  pidNamespace: '4026535075', matchedOsProcessInstanceKey: 'pri_complete',
  collectorId: 'collector', tenantId: 'tenant', environmentId: 'test' };
const weak = { ...complete, bindingId: 'weak', pidNamespace: undefined,
  matchedOsProcessInstanceKey: 'pri_partial' };
const query = { nativeSessionId: 'session', runtimeType: 'codex_ebpf_rustls',
  matchedPid: 190389, matchedStartTime: 'ticks:35243794', method: 'proc_fd',
  hostId: 'host', bootId: 'boot', collectorId: 'collector' };
const store = Object.create(RelationalBusinessStore.prototype);
store.initialize = async () => true;
let rows = [];
store.pool = { query: async (sql, parameters) => {
  assert.match(sql, /host_id = \$6/);
  assert.match(sql, /boot_id = \$7/);
  assert.match(sql, /collector_id = \$11/);
  assert.match(sql, /LIMIT 33/);
  assert.deepEqual(parameters, ['session', 'codex_ebpf_rustls', '190389', 'ticks:35243794',
    'proc_fd', 'host', 'boot', null, null, null, 'collector']);
  return { rows: rows.map(record => ({ record })) };
} };
for (let round = 0; round < 3; round += 1) {
  rows = [weak, complete];
  assert.equal((await store.loadSessionProcessBindingForGeneration(query))?.bindingId, 'complete');
  rows = [complete, { ...complete, pidNamespace: 'other', matchedOsProcessInstanceKey: 'pri_other' }];
  assert.equal(await store.loadSessionProcessBindingForGeneration(query), undefined);
  rows = Array.from({ length: 33 }, () => complete);
  assert.equal(await store.loadSessionProcessBindingForGeneration(query), undefined);
}
console.log('PASS 3 rounds: full identity wins over weak history; conflicting scopes and truncated lookups fail closed');
